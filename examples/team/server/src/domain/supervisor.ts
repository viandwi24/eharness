/**
 * The supervisor duty of the heartbeat (docs/plans/P53-supervisor-and-consistency.md). Pure.
 *
 * Every beat the server looks at the agent's own work with no model call: runs that ended failed
 * (after the automatic retries were exhausted), runs stuck too long, decisions waiting more than a
 * day, connections the agent uses that are in error, and the consistency findings about its data.
 * The beat decides per item: retry (a tool the server polices), escalate (a Decision Center
 * question with the diagnosis), or note. When there is nothing to do, there is no model call.
 *
 * What this module decides deterministically: how a stored failure text is classified, whether a
 * retry is allowed (own run, three a day, never for a failure a retry cannot change, never twice
 * for the same run), what the beat is told, and which memory tools the beat may use on its own
 * memory.
 */

import { agentMemory } from './memory.ts'
import { looksTransient } from './turn-retry.ts'

export const SUPERVISOR_RETRY_TOOL = 'heartbeat_retry_run'
export const SUPERVISOR_ASK_TOOL = 'heartbeat_ask_owner'

/** Retries the supervisor may start per agent per local day. */
export const MAX_SUPERVISOR_RETRIES_PER_DAY = 3
/** Questions to the owners per agent per local day (the Decision Center is not a feed). */
export const MAX_SUPERVISOR_QUESTIONS_PER_DAY = 5
/** A run that ended failed is looked at for this long. */
export const SUPERVISOR_FAILED_WINDOW_MS = 48 * 3_600_000
/** A run `running` with no activity this long is stuck; one waiting for a person, this long. */
export const SUPERVISOR_STUCK_MS = 2 * 3_600_000
export const SUPERVISOR_WAITING_MS = 6 * 3_600_000
/** A decision open this long is raised again to the supervisor. */
export const SUPERVISOR_DECISION_MS = 24 * 3_600_000
/** An item shown to a beat is not shown again within this long (unless it changed). */
export const SUPERVISOR_SEEN_MS = 24 * 3_600_000
/** The supervisor's own questions start with this: they are never "waiting decisions" themselves. */
export const SUPERVISOR_TITLE_PREFIX = 'Supervisor: '
export const MAX_SUPERVISOR_ITEMS = 15

// --- state -------------------------------------------------------------------------------------

/** What the supervisor keeps in the heartbeat state of an agent. */
export interface SupervisorState {
  /** Retries the supervisor started (the last week): the daily cap and "never twice" read this. */
  retries: Array<{ taskId: string; at: number }>
  /** Fingerprint of an item to the instant a beat was last shown it. */
  seen: Record<string, number>
  /** The running beat may edit the agent's own memory (its observation has memory findings). */
  memoryFix?: boolean
  /** Edits the running beat made to its own memory (consumed when the beat ends). */
  memoryChanges?: Array<{ at: number; tool: string; path: string; to?: string }>
  /** The Monday (local date) whose deep review ran. */
  deepWeek?: string
}

export const EMPTY_SUPERVISOR_STATE: SupervisorState = { retries: [], seen: {} }

const WEEK_MS = 7 * 24 * 3_600_000

/** Drop what is older than a week. */
export function pruneSupervisor(s: SupervisorState, now: number): SupervisorState {
  return {
    ...s,
    retries: s.retries.filter((r) => now - r.at < WEEK_MS),
    seen: Object.fromEntries(Object.entries(s.seen).filter(([, at]) => now - at < WEEK_MS)),
  }
}

// --- failures and the retry rule ---------------------------------------------------------------

/**
 * Why a run failed, from the text the task stored:
 *  - `transient`: a temporary provider or network problem; retrying can help
 *  - `unknown`: nothing says why; one retry is reasonable
 *  - `auth`: a sign-in or token problem; retry only when the connection is connected again
 *  - `denial`: the run asked for something it may not do (authority, a refused approval)
 *  - `permanent`: a budget, a context limit or a content filter: asking again gives the same answer
 */
export type FailureClass = 'transient' | 'unknown' | 'auth' | 'denial' | 'permanent'

const PERMANENT =
  /provider rejected the request|budget|credit|quota|insufficient|billing|payment required|context (?:length|window)|too long|content[ -]?(?:policy|filter)|safety/i
const DENIAL =
  /denied|not allowed|not permitted|not available in|outside (?:its|the|your) authority|authority|forbidden|declined|refused|permission|not authori[sz]ed|rejected by/i
const AUTH =
  /sign[- ]?in|needs-auth|unauthori[sz]ed|invalid api key|\b401\b|\b403\b|token (?:expired|invalid|revoked)|reconnect|credentials/i

export function classifyRunFailure(text: string | null | undefined): FailureClass {
  const t = text ?? ''
  if (/automatic retries did not help/i.test(t)) return 'transient'
  if (PERMANENT.test(t)) return 'permanent'
  if (DENIAL.test(t)) return 'denial'
  if (AUTH.test(t)) return 'auth'
  return looksTransient(t) ? 'transient' : 'unknown'
}

export type RetryVerdict = { ok: true; left: number } | { ok: false; reason: string }

/** May the supervisor re-run a failed run now? A readable reason when not. */
export function retryVerdict(input: {
  failure: FailureClass
  /** Retries the supervisor already started today. */
  retriesToday: number
  /** The supervisor already retried this run (it failed again). */
  alreadyRetried: boolean
  /** None of the connections the agent uses is in error or needs sign-in. */
  connectionsHealthy: boolean
}): RetryVerdict {
  if (input.alreadyRetried) {
    return {
      ok: false,
      reason: 'the supervisor already retried this run and it failed again: a person must look',
    }
  }
  if (input.retriesToday >= MAX_SUPERVISOR_RETRIES_PER_DAY) {
    return {
      ok: false,
      reason: `the daily limit of ${MAX_SUPERVISOR_RETRIES_PER_DAY} retries is used up`,
    }
  }
  if (input.failure === 'denial') {
    return {
      ok: false,
      reason:
        'it failed on a denial or authority problem: running it again gives the same answer. Escalate with the concrete fix (for a program: propose a change adding the missing tool)',
    }
  }
  if (input.failure === 'permanent') {
    return {
      ok: false,
      reason: 'it failed for a reason a retry does not change (budget, context size, content)',
    }
  }
  if (input.failure === 'auth' && !input.connectionsHealthy) {
    return { ok: false, reason: 'a connection the agent uses is still broken' }
  }
  return { ok: true, left: MAX_SUPERVISOR_RETRIES_PER_DAY - input.retriesToday }
}

// --- the observation ---------------------------------------------------------------------------

export type SupervisorKind =
  | 'run-failed'
  | 'run-stuck'
  | 'decision-waiting'
  | 'connection-broken'
  | 'consistency'

/** The consistency finding as the supervisor reads it (`app/consistency.ts`, structural). */
export interface ConsistencyLike {
  kind: string
  severity: 'high' | 'medium' | 'low'
  agentId: string | null
  subject: string
  explanation: string
  fix: string
  refs: string[]
  fingerprint: string
  memoryPath?: string | undefined
  line?: number | undefined
}

export interface SupervisorItem {
  kind: SupervisorKind
  /** Stable identity; it also carries what changes the verdict, so a change shows up again. */
  fingerprint: string
  title: string
  detail: string
  links: string[]
  taskId?: string
  failure?: FailureClass
  retry?: RetryVerdict
  finding?: ConsistencyLike
  /** An unacknowledged alarm (P54) already told the owner: the beat must not tell them again. */
  alarmed?: boolean
}

/** The findings about the agent's own memory (the beat may fix these itself). */
export const MEMORY_FINDING_KINDS: readonly string[] = [
  'memory-dead-ref',
  'memory-duplicate-topic',
  'memory-placeholder',
  'memory-system-state',
]
export const isMemoryFinding = (f: Pick<ConsistencyLike, 'kind'>): boolean =>
  MEMORY_FINDING_KINDS.includes(f.kind)

const ago = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000)
  if (h >= 48) return `${Math.floor(h / 24)} days`
  if (h >= 1) return `${h} h`
  return `${Math.max(1, Math.floor(ms / 60_000))} min`
}

export interface SupervisorTask {
  id: string
  title: string
  status: string
  summary: string | null
  endedAt: number | null
  lastActivityAt: number
  sessionId: string
  pendingKind: string | null
}

export interface SupervisorInput {
  now: number
  tasks: readonly SupervisorTask[]
  /** Sessions parked on an open decision (they show `running` but wait for a person). */
  parked: ReadonlySet<string>
  /** A later run of the same program finished fine: the failure no longer needs anything. */
  superseded: (task: SupervisorTask) => boolean
  decisions: ReadonlyArray<{ id: string; title: string; kind: string; createdAt: number }>
  connections: ReadonlyArray<{ id: string; label: string; status: string; statusMessage?: string }>
  state: SupervisorState
  retriesToday: number
  /**
   * What unacknowledged alarms already cover (`app/alarms.ts`): task ids of failed or stuck runs and
   * ids of broken connections. The owner was told; the supervisor keeps its retry logic but does not
   * list a stuck run or a broken connection again.
   */
  alarmed?: { tasks: ReadonlySet<string>; connections: ReadonlySet<string> }
}

/**
 * Failed runs, stuck runs, old decisions and broken connections of one agent, each with its retry
 * verdict. Not filtered by what a beat was already shown: `supervisor.ts` of the app does that.
 */
export function superviseObservation(input: SupervisorInput): SupervisorItem[] {
  const { now } = input
  const out: SupervisorItem[] = []
  const healthy = input.connections.every((c) => c.status !== 'error' && c.status !== 'needs-auth')
  const retried = new Set(input.state.retries.map((r) => r.taskId))
  for (const t of input.tasks) {
    const link = `/tasks/${t.id}`
    if (
      (t.status === 'failed' || t.status === 'interrupted' || t.status === 'timed_out') &&
      t.endedAt !== null &&
      now - t.endedAt < SUPERVISOR_FAILED_WINDOW_MS &&
      !input.superseded(t)
    ) {
      const failure = classifyRunFailure(t.summary)
      const retry = retryVerdict({
        failure,
        retriesToday: input.retriesToday,
        alreadyRetried: retried.has(t.id),
        connectionsHealthy: healthy,
      })
      out.push({
        kind: 'run-failed',
        fingerprint: `supervisor:run-failed:${t.id}:${failure}:${retry.ok ? 'retry' : 'no'}`,
        title: `Run ${t.status}: ${t.title}`,
        detail: `${t.summary ?? 'No summary.'}`,
        links: [link],
        taskId: t.id,
        failure,
        retry,
        ...(input.alarmed?.tasks.has(t.id) === true ? { alarmed: true } : {}),
      })
    } else if (
      t.status === 'running' &&
      !input.alarmed?.tasks.has(t.id) &&
      !input.parked.has(t.sessionId) &&
      now - t.lastActivityAt >= SUPERVISOR_STUCK_MS
    ) {
      out.push({
        kind: 'run-stuck',
        fingerprint: `supervisor:run-stuck:${t.id}`,
        title: `Run looks stuck: ${t.title}`,
        detail: `Running with no activity for ${ago(now - t.lastActivityAt)}.`,
        links: [link],
        taskId: t.id,
      })
    } else if (t.status === 'needs_action' && now - t.lastActivityAt >= SUPERVISOR_WAITING_MS) {
      out.push({
        kind: 'run-stuck',
        fingerprint: `supervisor:run-stuck:${t.id}`,
        title: `Run waits for a person: ${t.title}`,
        detail: `Needs an ${t.pendingKind === 'question' ? 'answer' : 'approval'} for ${ago(now - t.lastActivityAt)}.`,
        links: [link],
        taskId: t.id,
      })
    }
  }
  for (const d of input.decisions) {
    if (d.title.startsWith(SUPERVISOR_TITLE_PREFIX)) continue
    if (now - d.createdAt < SUPERVISOR_DECISION_MS) continue
    out.push({
      kind: 'decision-waiting',
      fingerprint: `supervisor:decision:${d.id}`,
      title: `Decision waiting ${ago(now - d.createdAt)}: ${d.title}`,
      detail: `An open ${d.kind} nobody answered.`,
      links: ['/decisions'],
    })
  }
  for (const c of input.connections) {
    if (c.status !== 'error' && c.status !== 'needs-auth') continue
    // the owner has an alarm for it (reconnect is theirs to do): nothing for the beat to decide
    if (input.alarmed?.connections.has(c.id) === true) continue
    out.push({
      kind: 'connection-broken',
      fingerprint: `supervisor:connection:${c.id}:${c.status}`,
      title:
        c.status === 'needs-auth'
          ? `Connection needs sign-in: ${c.label}`
          : `Connection in error: ${c.label}`,
      detail: c.statusMessage ?? 'Open Connectors and reconnect it.',
      links: ['/connectors'],
    })
  }
  return out
}

/** What the beat is told about one item. */
function itemLine(item: SupervisorItem, index: number, memoryDir: string): string[] {
  const head = `${index}. [${item.kind}] ${item.title}`
  const lines = [head, `   ${item.detail.replace(/\s+/g, ' ').slice(0, 400)}`]
  if (item.kind === 'run-failed' && item.retry !== undefined) {
    lines.push(
      `   task: ${item.taskId}; failure: ${item.failure}; retry: ${
        item.retry.ok
          ? `ALLOWED (${item.retry.left} left today)`
          : `NOT ALLOWED: ${item.retry.reason}`
      }`,
    )
  }
  if (item.alarmed === true) {
    lines.push(
      '   the owner already has an alarm for this (Health, Needs attention): do not ask them the same thing; retry when allowed, otherwise only note it, or escalate ONLY with a concrete change the alarm does not name.',
    )
  }
  if (item.kind === 'consistency' && item.finding !== undefined) {
    const f = item.finding
    lines.push(
      `   (${f.kind}, ${f.severity}) fix: ${f.fix.replace(/\s+/g, ' ').slice(0, 300)}`,
      ...(f.memoryPath === undefined || !isMemoryFinding(f)
        ? []
        : [
            `   file: ${memoryDir}/${f.memoryPath}${f.line === undefined ? '' : ` line ${f.line}`}${
              f.refs.length > 1
                ? `; related files: ${f.refs.map((r) => `${memoryDir}/${r}`).join(', ')}`
                : ''
            }`,
          ]),
    )
  }
  lines.push(
    `   fingerprint: ${item.fingerprint}${item.links.length === 0 ? '' : `; links: ${item.links.join(', ')}`}`,
  )
  return lines
}

export interface SupervisorPrompt {
  items: readonly SupervisorItem[]
  /** Items left out for space. */
  more: number
  /** The beat may fix findings of its own memory. */
  memoryFix: boolean
  /** The Monday deep review: every finding is listed, new or not. */
  deep: boolean
  /** The agent's own memory folder. */
  memoryDir: string
}

/** The steps of the beat prompt for the supervisor duty (each is a block of lines). */
export function supervisorSteps(s: SupervisorPrompt): string[][] {
  if (s.items.length === 0 && !s.deep) return []
  const steps: string[][] = []
  steps.push([
    'SUPERVISOR DUTY. The server watched your own work and lists what needs a decision. Each item',
    'is yours to decide: retry, escalate or note; keep one short reason per decision.',
    ...(s.items.length === 0
      ? ['(Nothing new: the weekly deep review found no inconsistency.)']
      : s.items.flatMap((item, i) => itemLine(item, i + 1, s.memoryDir))),
    ...(s.more > 0 ? [`(${s.more} more not shown; the next beat lists them.)`] : []),
  ])
  steps.push([
    `retry: call ${SUPERVISOR_RETRY_TOOL} with the task id and a reason, only where the item says`,
    'retry ALLOWED (the server refuses the rest: only your own runs, three a day, never twice for the',
    'same run, never for a denial, budget or content failure). It continues the run from where it stopped.',
    `escalate: call ${SUPERVISOR_ASK_TOOL} (one Decision Center question) with the diagnosis and the`,
    'concrete fix, so the owners can act: what failed, why you think so, what to change. Never re-run a',
    'run that failed because it was denied something or lacked authority: ask for the concrete change',
    '(for a program: propose_plan with program set to it, adding the tool it needs; or the question',
    'tool). note: write it down with the notes tool and move on.',
    `In the final answer list each decision as an item (kind "supervisor.<kind>", decision retry, escalate or`,
    'note, a reason, and the fingerprint above unchanged).',
  ])
  const own = s.items.filter((i) => i.finding !== undefined && isMemoryFinding(i.finding))
  const others = s.items.filter((i) => i.kind === 'consistency' && !own.includes(i))
  if (own.length > 0 && s.memoryFix) {
    steps.push([
      `MEMORY FIXES. The consistency findings about your own memory (${s.memoryDir}) you may fix yourself with`,
      'memory_view, memory_str_replace, memory_create, memory_insert, memory_delete and memory_rename, on',
      `files under ${s.memoryDir}/ only (the server refuses any other path). Read the file first. Keep every fact that is still`,
      'true. Merge two files on the same topic into one and delete the other. Remove volatile system state',
      '(who has which role, what is connected, what you can or cannot do) and empty placeholders. Replace a',
      'stale tool or program name with the current one ONLY after you verified it (runs_list, run_read,',
      'session_read, the program list); never invent a name: when you cannot verify, leave it and escalate.',
      'Never touch HEARTBEAT.md (the standing orders). For each file you changed add one item',
      '(kind "supervisor.memory-fix", links [the file], reason: what you changed and why); the owners get',
      'one summary of all your memory changes in the daily digest.',
    ])
  }
  if (others.length > 0) {
    steps.push([
      'Findings about programs, standing orders, routines, decisions or connections are NOT yours to',
      `edit. For each one ask the owner with ${SUPERVISOR_ASK_TOOL}, naming the concrete action (the fix on its line),`,
      'or for a program use propose_plan with program set to it. Never ask twice about the same finding.',
    ])
  }
  if (s.deep) {
    steps.push([
      'WEEKLY DEEP REVIEW: the list above is every finding about your memory and data today, not only the',
      'new ones. When you are done write ONE short note with the notes tool: chat "consistency report",',
      'evidence a /memories/... or /library/... path you looked at, confidence seen, listing what you fixed and',
      'what waits for the owners (decision note). If everything is consistent say so in that note.',
    ])
  }
  return steps
}

// --- memory tools of a beat --------------------------------------------------------------------

export const MEMORY_VIEW_TOOL = 'memory_view'
export const MEMORY_EDIT_TOOLS: readonly string[] = [
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
]
export const isMemoryTool = (toolName: string): boolean =>
  toolName === MEMORY_VIEW_TOOL || MEMORY_EDIT_TOOLS.includes(toolName)

/** The paths a memory call touches (`path`, or `old_path` and `new_path` of a rename). */
const memoryPathsOf = (input: unknown): string[] => {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return ['path', 'old_path', 'new_path'].flatMap((k) =>
    typeof i[k] === 'string' ? [(i[k] as string).trim().replace(/\/{2,}/g, '/')] : [],
  )
}

/** The path a memory call changes, for the beat log (`to` for a rename). */
export function memoryChangeOf(call: {
  toolName: string
  input: unknown
}): { tool: string; path: string; to?: string } | undefined {
  if (!MEMORY_EDIT_TOOLS.includes(call.toolName)) return undefined
  const i = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as Record<
    string,
    unknown
  >
  const path = call.toolName === 'memory_rename' ? i.old_path : i.path
  if (typeof path !== 'string') return undefined
  return {
    tool: call.toolName,
    path: path.trim(),
    ...(call.toolName === 'memory_rename' && typeof i.new_path === 'string'
      ? { to: i.new_path.trim() }
      : {}),
  }
}

/**
 * What the gate says about a memory call of a beat; undefined = allowed. Reading is open on the
 * agent's own memory; editing only while the beat's observation has memory findings, only under the
 * agent's own memory folder, never the checklist (`HEARTBEAT.md` holds the standing orders).
 */
export function memoryCallRefusal(
  call: { toolName: string; input: unknown },
  ctx: { agentId: string; fixing: boolean },
): string | undefined {
  if (!isMemoryTool(call.toolName)) return undefined
  const own = agentMemory(ctx.agentId)
  const edit = call.toolName !== MEMORY_VIEW_TOOL
  if (edit && !ctx.fixing) {
    return `Not available in a heartbeat: ${call.toolName}. Memory is edited only in a beat whose supervisor list has findings about your own memory.`
  }
  const paths = memoryPathsOf(call.input)
  if (paths.length === 0) return `Not allowed: ${call.toolName} needs a path under ${own}/.`
  for (const p of paths) {
    const inside = p === own || p.startsWith(`${own}/`)
    if (!inside || p.split('/').some((s) => s === '..')) {
      return `Not allowed: a beat may use memory only on its own folder (${own}/), not ${p}.`
    }
    if (edit && /(^|\/)HEARTBEAT\.md$/i.test(p)) {
      return 'Not allowed: HEARTBEAT.md holds the standing orders; a beat never edits it.'
    }
  }
  return undefined
}
