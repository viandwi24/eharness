/**
 * Cross-session reads and answers on eharness sessions (docs/plans/P32-team-example.md §5, §6.4,
 * §6.5, §8):
 *
 *  - `approvals()`: everything waiting for a person, across DM chats and delegated task sessions.
 *    Sources: the stored pending state of every agent's DM session, the children of the lead
 *    (`pendingSubagentApprovals`, which reads storage only, so it works on any instance) and the
 *    task rows still marked `needs_action` (drift safety net).
 *  - `answer()`: `respond()` on the right session from whichever instance got the request. A
 *    child's answer continues the child here; when its turn ends the `subagents` hook resolves the
 *    lead's parked wait and the lead continues, in whichever instance that is.
 *  - `reconcile()`: boot / periodic repair: `reconcileSubagentWaits` for every parent that can
 *    hold a parked wait (a crash between "child finished" and "wait resolved"), then a drift pass
 *    comparing the task rows with the session state.
 */
import type { HarnessSession } from 'eharness'
import { ASK_TOOL, answerOutput, pendingQuestions } from 'eharness/ask'
import { pendingSubagentApprovals, reconcileSubagentWaits } from 'eharness/subagent'
import type { AgentRepo, ChatMessage, TeamPort } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type { ApprovalOutcome, ApprovalRisk, ApprovalView } from '../../domain/approvals.ts'
import { dmSessionId } from '../../domain/chat.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
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
}

export interface TeamService extends TeamPort {
  reconcile(): Promise<ReconcileReport>
}

export interface TeamServiceDeps {
  agents: AgentRepo
  tasks: SqliteTaskStore
  now?: () => number
  log?: { warn(message: string, data?: Record<string, unknown>): void }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type PendingLike = Awaited<ReturnType<HarnessSession['stats']>>['pending']

export function createTeamService(factory: AgentFactory, deps: TeamServiceDeps): TeamService {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? { warn() {} }

  const allAgents = (): AgentDef[] => deps.agents.list({ includeArchived: true })
  const defById = (id: string): AgentDef | undefined => deps.agents.get(id)
  const defBySlug = (slug: string): AgentDef | undefined => deps.agents.getBySlug(slug)

  /** The agent a stored task session runs on (its row names the owner). */
  const sessionOfTask = (task: Task): HarnessSession | undefined => {
    const def = defById(task.agentId)
    return def === undefined ? undefined : factory.openSession(def, task.sessionId)
  }

  /** `dm:<agentId>` of a session id that starts with it (the DM itself or a child of the lead). */
  const dmOwner = (sessionId: string): AgentDef | undefined => {
    const m = /^dm:([^:]+)/.exec(sessionId)
    return m === null ? undefined : defById(m[1] as string)
  }

  function viewsOf(
    def: AgentDef,
    sessionId: string,
    parentSessionId: string | null,
    pending: PendingLike,
  ): ApprovalView[] {
    if (pending === null) return []
    const taskId = deps.tasks.getBySession(sessionId)?.id ?? null
    const base = {
      sessionId,
      parentSessionId,
      agentId: def.id,
      agentName: def.name,
      taskId,
    }
    const out: ApprovalView[] = []
    // answered items of a parallel batch wait for the others: hidden here, counted
    const answeredWaiting =
      pending.approvals.filter((a) => a.answer !== undefined).length +
      pending.clientTools.filter((c) => c.answer !== undefined).length
    for (const a of pending.approvals) {
      if (a.answer !== undefined) continue
      out.push({
        ...base,
        id: a.approvalId,
        kind: 'approval',
        toolCallId: a.toolCallId,
        toolName: a.toolName,
        input: a.input ?? null,
        risk: (a.risk as ApprovalRisk | undefined) ?? null,
        questions: null,
        answeredWaiting,
      })
    }
    const questions = pendingQuestions(pending)
    for (const q of questions) {
      const call = pending.clientTools.find((c) => c.toolCallId === q.toolCallId)
      if (call === undefined || call.result !== undefined || call.answer !== undefined) continue
      out.push({
        ...base,
        id: q.toolCallId,
        kind: 'question',
        toolCallId: q.toolCallId,
        toolName: ASK_TOOL,
        input: call.input ?? null,
        risk: null,
        questions: q.questions ?? [],
        answeredWaiting,
      })
    }
    return out
  }

  async function approvals(only: { sessionId?: string } = {}): Promise<ApprovalView[]> {
    if (only.sessionId !== undefined) {
      const task = deps.tasks.getBySession(only.sessionId)
      const def = task === undefined ? dmOwner(only.sessionId) : defById(task.agentId)
      if (def === undefined) return []
      const pending = await factory.peek(only.sessionId).pending()
      return viewsOf(def, only.sessionId, task?.parentSessionId ?? null, pending)
    }
    const out: ApprovalView[] = []
    const seen = new Set<string>()
    const add = (views: ApprovalView[]): void => {
      for (const v of views) {
        const key = `${v.sessionId}|${v.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(v)
      }
    }

    // an agent without any DM message cannot have a pending approval there (the lead may have
    // children to walk before its first message was indexed, so it is always read)
    const active = deps.tasks.activity()
    for (const def of allAgents()) {
      if (def.role !== 'lead' && !active.has(def.id)) continue
      const sessionId = dmSessionId(def.id)
      // reads go through `peek`: listing never runs session.start hooks or resumes a parked lead
      const session = factory.peek(sessionId)
      add(viewsOf(def, sessionId, null, await session.pending()))
      if (def.role === 'lead') {
        const children = await pendingSubagentApprovals(session, (childId) => factory.peek(childId))
        for (const found of children) {
          // the child index carries the agent (catalog key = slug); the task row is the fallback
          const task = deps.tasks.getBySession(found.sessionId)
          const owner =
            (found.agent === undefined ? undefined : defBySlug(found.agent)) ??
            (task === undefined ? undefined : defById(task.agentId))
          if (owner !== undefined) {
            add(viewsOf(owner, found.sessionId, found.parentSessionId, found.pending))
          }
        }
      }
    }
    // the index is a safety net for sessions the walk above does not reach (routine runs)
    for (const task of deps.tasks.list({ status: 'needs_action', limit: 500 })) {
      const def = defById(task.agentId)
      if (def === undefined) continue
      add(
        viewsOf(
          def,
          task.sessionId,
          task.parentSessionId,
          await factory.peek(task.sessionId).pending(),
        ),
      )
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
    const session = factory.openSession(def, view.sessionId)
    let run: ReturnType<HarnessSession['respond']>
    // items that still wait after this answer, as far as the stored state tells (a partial
    // answer is recorded without running anything, so the run settles fast and tells for sure)
    const before = await factory.peek(view.sessionId).pending()
    const predicted =
      before === null
        ? 0
        : Math.max(
            0,
            before.approvals.filter((a) => a.answer === undefined && a.granted !== true).length +
              before.clientTools.filter((c) => c.answer === undefined && c.result === undefined)
                .length +
              (before.externals ?? []).filter((e) => e.result === undefined).length -
              1,
          )
    if (body.kind === 'approval') {
      run = session.respond(
        {
          approvals: [
            {
              id: view.id,
              approved: body.approved,
              ...(body.reason === undefined ? {} : { reason: body.reason }),
              ...(body.note === undefined ? {} : { note: body.note }),
              actor: { id: actor.id, ...(actor.name === undefined ? {} : { name: actor.name }) },
            },
          ],
        },
        body.endTurn === undefined ? {} : { endTurn: body.endTurn },
      )
    } else {
      const pending = await factory.peek(view.sessionId).pending()
      const question = pendingQuestions(pending).find((q) => q.toolCallId === view.id)
      if (question === undefined) throw conflict(`question ${view.id} is not pending any more`)
      const output = answerOutput(
        question,
        body.answers === null ? null : { answers: body.answers },
      )
      run = session.respond({ toolOutputs: [output] })
    }
    // `respond` throws only busy / closed; a stale or invalid answer is an error stop of the run.
    // Give it a moment to fail fast, then let the continuation run on in the background.
    const result = run.result.catch(() => undefined)
    const settled = await Promise.race([result, sleep(250).then(() => undefined)])
    if (settled !== undefined && settled.stop === 'error') {
      const message = settled.error?.message ?? 'the answer was rejected'
      const code = settled.error?.code
      if (code === 'EH_INVALID_INPUT') throw invalid(message, code)
      throw conflict(message, code ?? 'ANSWER_REJECTED')
    }
    if (settled?.partial === true) {
      const left = settled.pending
      const remaining =
        left === undefined
          ? predicted
          : left.approvals.filter((a) => a.answer === undefined && a.granted !== true).length +
            left.clientTools.filter((c) => c.answer === undefined && c.result === undefined)
              .length +
            (left.externals ?? []).filter((e) => e.result === undefined).length
      return { status: 'recorded', remaining }
    }
    if (settled === undefined && predicted > 0) return { status: 'recorded', remaining: predicted }
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
        const facts = {
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
        deps.tasks.appendEvent(
          {
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
          },
          t,
        )
        out.push({ taskId: task.id, sessionId: task.sessionId, from: task.status, to: next.status })
      } catch (error) {
        log.warn(`drift check of ${task.sessionId} failed: ${String(error)}`)
      }
    }
    return out
  }

  async function abortTask(task: Task, reason?: string) {
    const session = sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    return session.requestAbort(reason)
  }

  async function messageTask(task: Task, text: string, mode: 'steer' | 'queue') {
    const session = sessionOfTask(task)
    if (session === undefined) throw notFound('agent', task.agentId)
    const queued = await session.enqueue(text, { mode })
    return { inboxId: queued.inboxId, target: queued.target }
  }

  return {
    approvals,
    answer,
    abortTask,
    messageTask,
    taskMessages,
    async reconcile() {
      const waits = await reconcileWaits()
      const drift = await reconcileDrift()
      return { waits, drift }
    },
  }
}
