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
import type { ApprovalRisk, ApprovalView } from '../../domain/approvals.ts'
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
    for (const a of pending.approvals) {
      out.push({
        ...base,
        id: a.approvalId,
        kind: 'approval',
        toolCallId: a.toolCallId,
        toolName: a.toolName,
        input: a.input ?? null,
        risk: (a.risk as ApprovalRisk | undefined) ?? null,
        questions: null,
      })
    }
    const questions = pendingQuestions(pending)
    for (const q of questions) {
      const call = pending.clientTools.find((c) => c.toolCallId === q.toolCallId)
      if (call === undefined || call.result !== undefined) continue
      out.push({
        ...base,
        id: q.toolCallId,
        kind: 'question',
        toolCallId: q.toolCallId,
        toolName: ASK_TOOL,
        input: call.input ?? null,
        risk: null,
        questions: q.questions ?? [],
      })
    }
    return out
  }

  /** `open` for `pendingSubagentApprovals`: a child without a row yet has nothing pending. */
  const openChild = (childSessionId: string): HarnessSession => {
    const task = deps.tasks.getBySession(childSessionId)
    const session = task === undefined ? undefined : sessionOfTask(task)
    return (session ??
      ({
        stats: async () => ({ pending: null }),
        children: async () => [],
      } as unknown as HarnessSession)) as HarnessSession
  }

  async function approvals(only: { sessionId?: string } = {}): Promise<ApprovalView[]> {
    if (only.sessionId !== undefined) {
      const task = deps.tasks.getBySession(only.sessionId)
      const def = task === undefined ? dmOwner(only.sessionId) : defById(task.agentId)
      if (def === undefined) return []
      const stats = await factory.openSession(def, only.sessionId).stats()
      return viewsOf(def, only.sessionId, task?.parentSessionId ?? null, stats.pending)
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
      const session = factory.openSession(def, sessionId)
      add(viewsOf(def, sessionId, null, (await session.stats()).pending))
      if (def.role === 'lead') {
        for (const found of await pendingSubagentApprovals(session as never, openChild as never)) {
          const task = deps.tasks.getBySession(found.sessionId)
          const owner = task === undefined ? undefined : defById(task.agentId)
          if (owner !== undefined) {
            add(viewsOf(owner, found.sessionId, found.parentSessionId, found.pending))
          }
        }
      }
    }
    // the index is a safety net for sessions the walk above does not reach (routine runs)
    for (const task of deps.tasks.list({ status: 'needs_action', limit: 500 })) {
      const def = defById(task.agentId)
      const session = sessionOfTask(task)
      if (def === undefined || session === undefined) continue
      add(viewsOf(def, task.sessionId, task.parentSessionId, (await session.stats()).pending))
    }
    return out
  }

  async function taskMessages(task: Task, limit: number): Promise<ChatMessage[]> {
    const session = sessionOfTask(task)
    if (session === undefined) return []
    return (await session.messages({ limit })) as unknown as ChatMessage[]
  }

  async function answer(
    view: ApprovalView,
    body: Parameters<TeamPort['answer']>[1],
    actor: Parameters<TeamPort['answer']>[2],
  ): Promise<void> {
    const def = defById(view.agentId)
    if (def === undefined) throw notFound('agent', view.agentId)
    const session = factory.openSession(def, view.sessionId)
    let run: ReturnType<HarnessSession['respond']>
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
      const pending = (await session.stats()).pending
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
      const session = sessionOfTask(task)
      if (session === undefined) continue
      try {
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

  return {
    approvals,
    answer,
    taskMessages,
    async reconcile() {
      const waits = await reconcileWaits()
      const drift = await reconcileDrift()
      return { waits, drift }
    },
  }
}
