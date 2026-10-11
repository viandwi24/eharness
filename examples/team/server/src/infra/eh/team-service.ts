/**
 * Cross-session reads and answers on eharness sessions (docs/plans/P32-team-example.md §5, §6.4,
 * §6.5, §8):
 *
 *  - `approvals()`: everything waiting for a person, across DM chats and delegated task sessions:
 *    the library's `listAttention` (eharness/activity) over the DM session of every agent that can
 *    hold something (it walks the lead's children through the child index, storage only, so it
 *    works on any instance) and the task rows still marked `needs_action` (drift safety net).
 *  - `answer()`: the library's idempotent `answerAttention` on the session that owns the item, from
 *    whichever instance got the request (the "already answered" mapping lives in the library). A
 *    child's answer continues the child here; when its turn ends the `subagents` hook resolves the
 *    lead's parked wait and the lead continues, in whichever instance that is.
 *  - `reconcile()`: boot / periodic repair: `reconcileSubagentWaits` for every parent that can
 *    hold a parked wait (a crash between "child finished" and "wait resolved"), then a drift pass
 *    comparing the task rows with the session state.
 */
import { type HarnessSession, handleResumeRequest, isHarnessError } from 'eharness'
import {
  type ActivityStore,
  type AttentionAnswer,
  answerAttention,
  listAttention,
} from 'eharness/activity'
import { ASK_TOOL, answerOutput, pendingQuestions } from 'eharness/ask'
import {
  type BackgroundReconcileEntry,
  reconcileBackgroundChildren,
  reconcileSubagentWaits,
} from 'eharness/subagent'
import type { AgentRepo, ChatMessage, EventAppender, TeamPort } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type { ApprovalOutcome, ApprovalRisk, ApprovalView } from '../../domain/approvals.ts'
import { dmSessionId } from '../../domain/chat.ts'
import { ALREADY_ANSWERED, conflict, invalid, notFound } from '../../domain/errors.ts'
import { deriveTaskStatus, type Task } from '../../domain/tasks.ts'
import type { SqliteTaskStore } from '../db/tasks-repo.ts'
import type { AgentFactory } from './agent-factory.ts'

/** A turn whose heartbeat is older than this is dead (core default `recovery.staleMs`). */
const STALE_TURN_MS = 120_000

export interface ReconcileReport {
  waits: Array<{
    parentSessionId: string
    waitId: string
    childSessionId: string
    status: 'resolved' | 'busy' | 'skipped'
  }>
  drift: Array<{ taskId: string; sessionId: string; from: string; to: string }>
  /** Turns a dead process left active, repaired at once (`session.recover()`). */
  recovered: Array<{ sessionId: string; turnId: string }>
  /** Background children: reports delivered / rows updated by `reconcileBackgroundChildren`. */
  background: Array<BackgroundReconcileEntry & { parentSessionId: string }>
  /** Reports of finished children that no turn of the lead saw and no wake was held for. */
  stranded: Array<{ sessionId: string; messageId: string }>
}

export interface TeamService extends TeamPort {
  reconcile(): Promise<ReconcileReport>
}

export interface TeamServiceDeps {
  agents: AgentRepo
  tasks: SqliteTaskStore
  events: EventAppender
  /** The shared feed (`attention-answered` events). */
  activity: ActivityStore
  now?: () => number
  log?: { warn(message: string, data?: Record<string, unknown>): void }
}

const alreadyAnswered = (): Error =>
  conflict('This request was already answered or is no longer waiting.', ALREADY_ANSWERED)

export function createTeamService(factory: AgentFactory, deps: TeamServiceDeps): TeamService {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? { warn() {} }

  const allAgents = (): AgentDef[] => deps.agents.list({ includeArchived: true })
  const defById = (id: string): AgentDef | undefined => deps.agents.get(id)
  const defBySlug = (slug: string): AgentDef | undefined => deps.agents.getBySlug(slug)

  /** The agent a stored task session runs on (its row names the owner). */
  const sessionOfTask = async (task: Task): Promise<HarnessSession | undefined> => {
    const def = defById(task.agentId)
    if (def === undefined) return undefined
    await factory.prepare(def)
    return factory.openSession(def, task.sessionId)
  }

  /** `dm:<agentId>` of a session id that starts with it (the DM itself or a child of the lead). */
  const dmOwner = (sessionId: string): AgentDef | undefined => {
    const m = /^dm:([^:]+)/.exec(sessionId)
    return m === null ? undefined : defById(m[1] as string)
  }

  /** The agent that runs a session: the child index / root info (slug), the task row, the DM id. */
  const ownerOf = (item: {
    agent?: string | undefined
    sessionId: string
  }): AgentDef | undefined => {
    const bySlug = item.agent === undefined ? undefined : defBySlug(item.agent)
    if (bySlug !== undefined) return bySlug
    const task = deps.tasks.getBySession(item.sessionId)
    return task === undefined ? dmOwner(item.sessionId) : defById(task.agentId)
  }

  /** Everything waiting for a person: the library's attention queue, in the shape the web reads. */
  async function approvals(only: { sessionId?: string } = {}): Promise<ApprovalView[]> {
    let roots: Array<{ sessionId: string; agent?: string }>
    if (only.sessionId !== undefined) {
      const owner = ownerOf({ sessionId: only.sessionId })
      if (owner === undefined) return []
      roots = [{ sessionId: only.sessionId, agent: owner.slug }]
    } else {
      // an agent without any DM message cannot have a pending approval there (the lead may have
      // children to walk before its first message was indexed, so it is always read)
      const active = deps.tasks.activity()
      roots = allAgents()
        .filter((def) => def.role === 'lead' || active.has(def.id))
        .map((def) => ({ sessionId: dmSessionId(def.id), agent: def.slug }))
      // the index is a safety net for sessions the walk above does not reach (routine runs)
      for (const task of deps.tasks.list({ status: 'needs_action', limit: 500 })) {
        const def = defById(task.agentId)
        if (def !== undefined) roots.push({ sessionId: task.sessionId, agent: def.slug })
      }
    }
    // reads go through `peek`: listing never runs session.start hooks or resumes a parked lead
    const items = await listAttention({
      roots,
      peek: (sessionId) => factory.peek(sessionId),
      ...(only.sessionId === undefined ? {} : { maxDepth: 0 }),
    })
    const questions = new Map<string, ReturnType<typeof pendingQuestions>>()
    const out: ApprovalView[] = []
    for (const item of items) {
      const owner = ownerOf(item)
      if (owner === undefined) continue
      const base = {
        sessionId: item.sessionId,
        parentSessionId: item.parentSessionId,
        agentId: owner.id,
        agentName: owner.name,
        taskId: deps.tasks.getBySession(item.sessionId)?.id ?? null,
        id: item.id,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
        answeredWaiting: item.answeredWaiting,
      }
      if (item.kind === 'approval') {
        out.push({
          ...base,
          kind: 'approval',
          risk: (item.risk as ApprovalRisk | null) ?? null,
          questions: null,
        })
      } else if (item.kind === 'client-tool' && item.toolName === ASK_TOOL) {
        let found = questions.get(item.sessionId)
        if (found === undefined) {
          found = pendingQuestions(await factory.peek(item.sessionId).pending())
          questions.set(item.sessionId, found)
        }
        const q = found.find((x) => x.toolCallId === item.id)
        if (q !== undefined) {
          out.push({ ...base, kind: 'question', risk: null, questions: q.questions ?? [] })
        }
      }
    }
    return out
  }

  async function taskMessages(task: Task, limit: number): Promise<ChatMessage[]> {
    return (await factory.peek(task.sessionId).messages({ limit })) as unknown as ChatMessage[]
  }

  async function answer(
    view: ApprovalView,
    body: Parameters<TeamPort['answer']>[1],
    actor: Parameters<TeamPort['answer']>[2],
  ): Promise<ApprovalOutcome> {
    const def = defById(view.agentId)
    if (def === undefined) throw notFound('agent', view.agentId)
    await factory.prepare(def)
    let answer: AttentionAnswer
    if (body.kind === 'approval') {
      answer = {
        kind: 'approval',
        approved: body.approved,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.remember === undefined ? {} : { remember: body.remember }),
        ...(body.endTurn === undefined ? {} : { endTurn: body.endTurn }),
      }
    } else {
      // the question was answered (or its message moved on) before this request got here
      const pending = await factory.peek(view.sessionId).pending()
      const question = pendingQuestions(pending).find((q) => q.toolCallId === view.id)
      if (question === undefined) throw alreadyAnswered()
      const output = answerOutput(
        question,
        body.answers === null ? null : { answers: body.answers },
      )
      answer = {
        kind: 'client-tool',
        ...('output' in output ? { output: output.output } : { errorText: output.errorText }),
      }
    }
    let result: Awaited<ReturnType<typeof answerAttention>>
    try {
      result = await answerAttention(view.id, {
        sessionId: view.sessionId,
        answer,
        open: (sessionId) => factory.openSession(def, sessionId),
        peek: (sessionId) => factory.peek(sessionId),
        actor: { id: actor.id, ...(actor.name === undefined ? {} : { name: actor.name }) },
        store: deps.activity,
        agentId: def.id,
        log,
      })
    } catch (error) {
      if (isHarnessError(error, 'EH_INVALID_INPUT')) throw invalid(error.message, error.code)
      if (
        isHarnessError(error) &&
        error.code !== 'EH_SESSION_BUSY' &&
        error.code !== 'EH_SESSION_CLOSED' &&
        error.code !== 'EH_STORAGE'
      ) {
        throw conflict(error.message, error.code)
      }
      throw error
    }
    if (result.status === 'already-answered') throw alreadyAnswered()
    if (result.status === 'not-found') throw notFound('approval', view.id)
    if (result.status === 'recorded')
      return { status: 'recorded', remaining: result.remaining ?? 0 }
    // the continuation of a lead's own question / approval ended: reports that arrived meanwhile
    // (and have no held wake, e.g. stored before a restart) wake it now
    if (def.role === 'lead' && view.sessionId === dmSessionId(def.id)) {
      void result.done?.then(async (r) => {
        if (r?.stop !== 'complete') return
        try {
          await wakeStranded(def, view.sessionId)
        } catch (error) {
          log.warn(`waking stranded reports of ${view.sessionId} failed: ${String(error)}`)
        }
      })
    }
    return { status: 'resumed' }
  }

  async function reconcileWaits(): Promise<ReconcileReport['waits']> {
    const out: ReconcileReport['waits'] = []
    const parents = new Map<string, AgentDef>()
    for (const def of allAgents()) {
      if (def.role === 'lead') parents.set(dmSessionId(def.id), def)
    }
    for (const task of deps.tasks.active()) {
      if (task.parentSessionId === null) continue
      const owner = dmOwner(task.parentSessionId)
      if (owner !== undefined) parents.set(task.parentSessionId, owner)
    }
    for (const [sessionId, def] of parents) {
      try {
        await factory.prepare(def)
        const session = factory.openSession(def, sessionId)
        const entries = await reconcileSubagentWaits(session as never, {
          openChild: (childSessionId, info) => {
            const bySlug = info.agent === undefined ? undefined : defBySlug(info.agent)
            const task = deps.tasks.getBySession(childSessionId)
            const child = bySlug ?? (task === undefined ? undefined : defById(task.agentId))
            if (child === undefined) throw new Error(`no agent for child ${childSessionId}`)
            return factory.openSession(child, childSessionId) as never
          },
          log,
        })
        for (const e of entries) out.push({ parentSessionId: sessionId, ...e })
      } catch (error) {
        log.warn(`reconcile of ${sessionId} failed: ${String(error)}`)
      }
    }
    return out
  }

  /** The parent sessions that can hold background children: every lead DM and the task parents. */
  function parentSessions(): Map<string, AgentDef> {
    const parents = new Map<string, AgentDef>()
    for (const def of allAgents()) {
      if (def.role === 'lead') parents.set(dmSessionId(def.id), def)
    }
    for (const task of deps.tasks.active()) {
      if (task.parentSessionId === null) continue
      const owner = dmOwner(task.parentSessionId)
      if (owner !== undefined) parents.set(task.parentSessionId, owner)
    }
    return parents
  }

  /**
   * Boot / periodic: close the turns a dead process left active (no waiting for the stale
   * timeout: the instance id is stable, spec 05 §9.2). Tool calls get `Interrupted:` results,
   * the stored message becomes schema-valid and the chat can continue at once.
   */
  async function recoverOrphans(): Promise<ReconcileReport['recovered']> {
    const out: ReconcileReport['recovered'] = []
    const candidates = new Map<string, AgentDef>()
    for (const def of allAgents()) candidates.set(dmSessionId(def.id), def)
    for (const task of deps.tasks.active()) {
      const def = defById(task.agentId)
      if (def !== undefined) candidates.set(task.sessionId, def)
    }
    for (const [sessionId, def] of candidates) {
      try {
        const stats = await factory.peek(sessionId).stats()
        if (stats.activeTurn === null) continue
        await factory.prepare(def)
        const result = await factory.openSession(def, sessionId).recover()
        if (result.recovered) out.push({ sessionId, turnId: result.turnId })
      } catch (error) {
        // a turn of this process runs (busy) or the session cannot be opened now: next pass
        if (!isHarnessError(error, 'EH_SESSION_BUSY'))
          log.warn(`recover of ${sessionId} failed: ${String(error)}`)
      }
    }
    return out
  }

  async function reconcileBackground(): Promise<ReconcileReport['background']> {
    const out: ReconcileReport['background'] = []
    for (const [sessionId, def] of parentSessions()) {
      try {
        await factory.prepare(def)
        const session = factory.openSession(def, sessionId)
        const entries = await reconcileBackgroundChildren(session as never, {
          openChild: (childSessionId, info) => {
            const bySlug = info.agent === undefined ? undefined : defBySlug(info.agent)
            const task = deps.tasks.getBySession(childSessionId)
            const child = bySlug ?? (task === undefined ? undefined : defById(task.agentId))
            if (child === undefined) throw new Error(`no agent for child ${childSessionId}`)
            return factory.openSession(child, childSessionId) as never
          },
          timeoutMs: factory.background.timeoutMs > 0 ? factory.background.timeoutMs : undefined,
          startGraceMs: factory.background.startGraceMs,
          waitingReminderMs: factory.background.waitingReminderMs,
          outputToolName: 'agent_output',
          messageToolName: 'send_message',
          now,
          log,
        })
        for (const e of entries) {
          out.push({ parentSessionId: sessionId, ...e })
          const task = deps.tasks.getBySession(e.sessionId)
          if (task === undefined || e.outcome !== 'reported') continue
          const next =
            e.status === 'timed_out'
              ? { status: 'timed_out' as const, summary: 'Timed out' }
              : e.status === 'not_started'
                ? { status: 'failed' as const, summary: 'Failed to start' }
                : undefined
          if (next === undefined || task.status === next.status) continue
          if (e.status === 'timed_out' && task.status !== 'running') continue
          const t = now()
          const row = deps.tasks.update(task.sessionId, {
            status: next.status,
            pendingKind: null,
            now: t,
            summary: next.summary,
          })
          deps.events.append({
            type: 'task-changed',
            agentId: task.agentId,
            sessionId: task.sessionId,
            payload: {
              taskId: task.id,
              status: next.status,
              pendingKind: null,
              title: row?.title ?? task.title,
              parentSessionId: task.parentSessionId,
              reason: 'reconcile',
            },
            at: t,
          })
        }
      } catch (error) {
        log.warn(`background reconcile of ${sessionId} failed: ${String(error)}`)
      }
    }
    return out
  }

  /** Compare every unfinished task row with its session and fix what a crash left behind. */
  async function reconcileDrift(): Promise<ReconcileReport['drift']> {
    const out: ReconcileReport['drift'] = []
    for (const task of deps.tasks.active()) {
      try {
        const session = factory.peek(task.sessionId)
        const stats = await session.stats()
        const t = now()
        const turn = stats.activeTurn
        const fresh = turn !== null && t - turn.heartbeatAt < STALE_TURN_MS
        const history = await session.messages({ limit: 10 })
        const last = history.findLast((m) => m.role === 'assistant')
        const lastStop = last?.metadata?.eharness?.stop ?? null
        const interruptedNotice = history.some(
          (m) =>
            m.metadata?.eharness?.kind === 'eh.notice' &&
            (m.parts[0] as { data?: { code?: string } } | undefined)?.data?.code ===
              'EH_TURN_INTERRUPTED',
        )
        const facts = {
          interruptedNotice,
          pendingApprovals: stats.pending?.approvals.length ?? 0,
          pendingQuestions:
            stats.pending?.clientTools.filter((c) => c.result === undefined).length ?? 0,
          activeTurn: fresh,
          staleTurn: turn !== null && !fresh,
          lastStop,
        }
        let next = deriveTaskStatus(facts)
        // never started a turn and nothing runs: the process died before the first message
        if (lastStop === null && turn === null && t - task.startedAt > STALE_TURN_MS) {
          next = { status: 'failed', pendingKind: null }
        }
        if (next.status === task.status && next.pendingKind === task.pendingKind) continue
        const row = deps.tasks.update(task.sessionId, { ...next, now: t })
        deps.events.append({
          type: 'task-changed',
          agentId: task.agentId,
          sessionId: task.sessionId,
          payload: {
            taskId: task.id,
            status: next.status,
            pendingKind: next.pendingKind,
            title: row?.title ?? task.title,
            parentSessionId: task.parentSessionId,
            reason: 'reconcile',
          },
          at: t,
        })
        out.push({ taskId: task.id, sessionId: task.sessionId, from: task.status, to: next.status })
      } catch (error) {
        log.warn(`drift check of ${task.sessionId} failed: ${String(error)}`)
      }
    }
    return out
  }

  /**
   * Finished-child reports (`eh.event` named `subagent`) stored after the lead's newest
   * assistant message that no wake is held for: a wake that was only held in the memory of a
   * process that restarted (before the library made it durable, ADR-0054). Enqueues the same
   * `wake:<messageId>` item the core would have, so a held one is never doubled.
   */
  async function wakeStranded(
    def: AgentDef,
    sessionId: string,
  ): Promise<Array<{ sessionId: string; messageId: string }>> {
    const peek = factory.peek(sessionId)
    const stats = await peek.stats()
    if (stats.pending !== null) return [] // an answer comes first: the held wake runs after it
    const turn = stats.activeTurn
    if (turn !== null && now() - turn.heartbeatAt < STALE_TURN_MS) return []
    const history = await peek.messages({ limit: 80 })
    let lastAssistant = -1
    history.forEach((m, i) => {
      if (m.role === 'assistant' && m.metadata?.eharness?.kind === undefined) lastAssistant = i
    })
    let newest: string | undefined
    for (const m of history.slice(lastAssistant + 1)) {
      const eh = m.metadata?.eharness
      if (eh?.kind !== 'eh.event' || eh.deliveredIn !== undefined) continue
      const part = m.parts.find((p) => p.type === 'data-eh.event') as
        | { data?: { name?: string; data?: { status?: string } } }
        | undefined
      if (part?.data?.name !== 'subagent') continue
      const status = part.data.data?.status
      if (status === 'completed' || status === 'failed' || status === 'stopped') newest = m.id
    }
    if (newest === undefined) return []
    const inbox = factory.storage.inbox
    const item = { kind: 'wake' as const, messageId: newest, at: now() }
    const key = `wake:${newest}`
    if (inbox.enqueueOnce === undefined) return []
    const stored = await inbox.enqueueOnce(sessionId, { ...item, dedupeKey: key })
    if (stored.duplicate) return []
    // a live session claims it; open the lead's session here so this instance runs it
    await factory.prepare(def)
    await factory.openSession(def, sessionId).ready()
    await inbox.notify?.(sessionId)
    return [{ sessionId, messageId: newest }]
  }

  async function reconcileStranded(): Promise<ReconcileReport['stranded']> {
    const out: ReconcileReport['stranded'] = []
    for (const def of allAgents()) {
      if (def.role !== 'lead') continue
      try {
        out.push(...(await wakeStranded(def, dmSessionId(def.id))))
      } catch (error) {
        log.warn(`stranded reports of ${def.id} could not be woken: ${String(error)}`)
      }
    }
    return out
  }

  async function abortTask(task: Task, reason?: string) {
    const session = await sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    return session.requestAbort(reason)
  }

  async function messageTask(task: Task, text: string, mode: 'steer' | 'queue') {
    const session = await sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    const queued = await session.enqueue(text, { mode })
    return { inboxId: queued.inboxId, target: queued.target }
  }

  async function resumeTask(task: Task, request: Request): Promise<Response> {
    const session = await sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    return handleResumeRequest(session, request)
  }

  return {
    approvals,
    answer,
    resumeTask,
    abortTask,
    messageTask,
    taskMessages,
    async reconcile() {
      const recovered = await recoverOrphans()
      const waits = await reconcileWaits()
      const background = await reconcileBackground()
      const drift = await reconcileDrift()
      const stranded = await reconcileStranded()
      return { recovered, waits, background, drift, stranded }
    },
  }
}
