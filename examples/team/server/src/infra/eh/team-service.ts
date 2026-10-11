/**
 * Cross-session reads and answers on eharness sessions (docs/plans/P32-team-example.md §5, §6.4,
 * §6.5, §8):
 *
 *  - `approvals()`: everything waiting for a person, across DM chats and delegated task sessions:
 *    the library's `listAttention` (eharness/activity) over the DM session of every agent that can
 *    hold something (it walks the lead's children through the child index, storage only, so it
 *    works on any instance) and the task rows still marked `needs_action` (drift safety net).
 *  - `attentionRoots()` / `afterLeadAnswer()`: the hooks of the library's `attention` routes
 *    (`infra/eh/harness-http.ts`). Answers are the library's idempotent `answerAttention`; a
 *    child's answer continues the child here; when its turn ends the `subagents` hook resolves the
 *    lead's parked wait and the lead continues, in whichever instance that is.
 *  - `reconcile()`: boot / periodic repair: `reconcileSubagentWaits` for every parent that can
 *    hold a parked wait (a crash between "child finished" and "wait resolved"), then a drift pass
 *    comparing the task rows with the session state.
 */
import { type HarnessSession, isHarnessError } from 'eharness'
import { type ActivityStore, type AttentionItem, listAttention } from 'eharness/activity'
import { ASK_TOOL, pendingQuestions } from 'eharness/ask'
import {
  type BackgroundReconcileEntry,
  reconcileBackgroundChildren,
  reconcileSubagentWaits,
} from 'eharness/subagent'
import type {
  AgentRepo,
  ChatMessage,
  EventAppender,
  TeamPort,
  ThreadStore,
} from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type { ApprovalRisk, ApprovalView, QuestionView } from '../../domain/approvals.ts'
import { notFound } from '../../domain/errors.ts'
import { deriveTaskStatus, type Task } from '../../domain/tasks.ts'
import { isThreadSession, legacyThreadSessionId, parseChatSession } from '../../domain/threads.ts'
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
  /** The sessions the attention queue starts from (every lead / active DM, tasks needing action). */
  attentionRoots(): Array<{ sessionId: string; agent: string }>
  /**
   * After the continuation of an answer ended: reports that arrived meanwhile and have no held
   * wake (stored before a restart) wake the lead now. No-op for any other session.
   */
  afterLeadAnswer(sessionId: string): Promise<void>
  /** `attention.decorate` of the library's HTTP module (see `AttentionExtra`). */
  decorateAttention(item: AttentionItem): Promise<AttentionExtra | null>
}

/** What `GET /attention` carries as `extra` for the team (and what `GET /approvals` is built from). */
export type AttentionExtra = {
  agentId: string
  agentName: string
  taskId: string | null
  /** `approval` or `question` (the web's name of a client-tool question). */
  view: 'approval' | 'question'
  questions: import('ai').JSONValue
}

export interface TeamServiceDeps {
  agents: AgentRepo
  tasks: SqliteTaskStore
  /** Chat threads: every thread session of an agent is a root, a parent of delegations, a recovery candidate. */
  threads: ThreadStore
  events: EventAppender
  /** The shared feed. */
  activity: ActivityStore
  now?: () => number
  log?: { warn(message: string, data?: Record<string, unknown>): void }
}

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

  /** The agent of a chat thread session or of a child of one (`dm:<id>…` or `chat:<id>:<thread>…`). */
  const dmOwner = (sessionId: string): AgentDef | undefined => {
    const chat = parseChatSession(sessionId)
    return chat === undefined ? undefined : defById(chat.agentId)
  }

  /** Every thread session of an agent, archived ones included (they may still wait for an answer). */
  const threadSessions = (def: AgentDef): string[] => [
    ...new Set([legacyThreadSessionId(def.id), ...deps.threads.sessionsOf(def.id)]),
  ]

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

  /** The sessions the attention queue starts from. */
  function attentionRoots(): Array<{ sessionId: string; agent: string }> {
    // an agent without any DM message cannot have a pending approval there (the lead may have
    // children to walk before its first message was indexed, so it is always read)
    const active = deps.tasks.activity()
    const roots = allAgents()
      .filter((def) => def.role === 'lead' || active.has(def.id))
      .flatMap((def) => threadSessions(def).map((sessionId) => ({ sessionId, agent: def.slug })))
    // the index is a safety net for sessions the walk above does not reach (routine runs)
    for (const task of deps.tasks.list({ status: 'needs_action', limit: 500 })) {
      const def = defById(task.agentId)
      if (def !== undefined) roots.push({ sessionId: task.sessionId, agent: def.slug })
    }
    return roots
  }

  /**
   * What the team adds to an item of the library's attention queue (`attention.decorate` of
   * `eharness/http`, so `GET /attention` carries it as `extra`): the agent, the task and the
   * question texts. `null` hides an item the team cannot place (no owner, a client tool that is
   * not a readable question).
   */
  async function decorateAttention(item: AttentionItem): Promise<AttentionExtra | null> {
    const owner = ownerOf(item)
    if (owner === undefined) return null
    const base = {
      agentId: owner.id,
      agentName: owner.name,
      taskId: deps.tasks.getBySession(item.sessionId)?.id ?? null,
    }
    if (item.kind === 'approval') return { ...base, view: 'approval', questions: null }
    if (item.kind === 'client-tool' && item.toolName === ASK_TOOL) {
      // reads go through `peek`: nothing resumes
      const found = pendingQuestions(await factory.peek(item.sessionId).pending())
      const q = found.find((x) => x.toolCallId === item.id)
      if (q !== undefined) {
        return { ...base, view: 'question', questions: (q.questions ?? []) as never }
      }
    }
    return null
  }

  /** Everything waiting for a person: the library's attention queue, in the shape of `GET /approvals`. */
  async function approvals(): Promise<ApprovalView[]> {
    // reads go through `peek`: listing never runs session.start hooks or resumes a parked lead
    const items = await listAttention({
      roots: attentionRoots(),
      peek: (sessionId) => factory.peek(sessionId),
    })
    const out: ApprovalView[] = []
    for (const item of items) {
      const extra = await decorateAttention(item)
      if (extra === null) continue
      out.push({
        id: item.id,
        kind: extra.view,
        sessionId: item.sessionId,
        parentSessionId: item.parentSessionId,
        agentId: extra.agentId,
        agentName: extra.agentName,
        taskId: extra.taskId,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
        risk: extra.view === 'approval' ? ((item.risk as ApprovalRisk | null) ?? null) : null,
        questions: extra.questions as QuestionView[] | null,
        answeredWaiting: item.answeredWaiting,
      })
    }
    return out
  }

  async function taskMessages(task: Task, limit: number): Promise<ChatMessage[]> {
    return (await factory.peek(task.sessionId).messages({ limit })) as unknown as ChatMessage[]
  }

  async function afterLeadAnswer(sessionId: string): Promise<void> {
    const def = dmOwner(sessionId)
    if (def?.role !== 'lead' || !isThreadSession(sessionId)) return
    try {
      await wakeStranded(def, sessionId)
    } catch (error) {
      log.warn(`waking stranded reports of ${sessionId} failed: ${String(error)}`)
    }
  }

  async function reconcileWaits(): Promise<ReconcileReport['waits']> {
    const out: ReconcileReport['waits'] = []
    const parents = new Map<string, AgentDef>()
    for (const def of allAgents()) {
      if (def.role === 'lead')
        for (const sessionId of threadSessions(def)) parents.set(sessionId, def)
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
      if (def.role === 'lead')
        for (const sessionId of threadSessions(def)) parents.set(sessionId, def)
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
    for (const def of allAgents()) {
      for (const sessionId of threadSessions(def)) candidates.set(sessionId, def)
      // the rolling session of a heartbeat has no task row: it is recovered like a chat
      candidates.set(`heartbeat:${def.id}`, def)
    }
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
        for (const sessionId of threadSessions(def)) {
          out.push(...(await wakeStranded(def, sessionId)))
        }
      } catch (error) {
        log.warn(`stranded reports of ${def.id} could not be woken: ${String(error)}`)
      }
    }
    return out
  }

  async function messageTask(task: Task, text: string, mode: 'steer' | 'queue') {
    const session = await sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    const queued = await session.enqueue(text, { mode })
    return { inboxId: queued.inboxId, target: queued.target }
  }

  return {
    approvals,
    decorateAttention,
    attentionRoots,
    afterLeadAnswer,
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
