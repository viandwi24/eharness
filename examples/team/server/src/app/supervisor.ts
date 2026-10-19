/**
 * The supervisor duty of the heartbeat (docs/plans/P53-supervisor-and-consistency.md): what the
 * server observes about an agent's own work on every beat, the one tool that re-runs a failed run
 * (policed here), the question to the owners, and the record of memory edits the beat made.
 *
 * Nothing here calls a model. `supervise` returns what a beat should be told; no items and no
 * deep review means the beat is not started for the supervisor's sake.
 */
import { checkBody, checkTitle } from '../domain/decisions.ts'
import { localDay, periodStarts } from '../domain/heartbeat.ts'
import { agentMemory } from '../domain/memory.ts'
import { isMonday, mondayOf } from '../domain/order-hygiene.ts'
import { parseProgramSession } from '../domain/programs.ts'
import {
  type ConsistencyLike,
  classifyRunFailure,
  EMPTY_SUPERVISOR_STATE,
  isMemoryFinding,
  MAX_SUPERVISOR_ITEMS,
  MAX_SUPERVISOR_QUESTIONS_PER_DAY,
  memoryChangeOf,
  pruneSupervisor,
  retryVerdict,
  SUPERVISOR_SEEN_MS,
  SUPERVISOR_TITLE_PREFIX,
  type SupervisorItem,
  type SupervisorPrompt,
  type SupervisorState,
  superviseObservation,
} from '../domain/supervisor.ts'
import { getAgent } from './agents.ts'
import { openAlarms } from './alarms.ts'
import { consistencyFindings } from './consistency.ts'
import { changed } from './decisions.ts'
import type { Deps } from './ports.ts'
import { retryTask } from './tasks.ts'
import { sessionsWithOpenDecision } from './work-queue.ts'

const stateOf = (deps: Deps, agentId: string): SupervisorState =>
  deps.heartbeat.store.state(agentId).supervisor ?? EMPTY_SUPERVISOR_STATE

const setSupervisor = (
  deps: Deps,
  agentId: string,
  now: number,
  fn: (s: SupervisorState) => SupervisorState,
): void => {
  deps.heartbeat.store.updateState(
    agentId,
    (s) => ({ ...s, supervisor: pruneSupervisor(fn(s.supervisor ?? EMPTY_SUPERVISOR_STATE), now) }),
    now,
  )
}

/** Retries the supervisor already started today (team timezone). */
function retriesToday(deps: Deps, state: SupervisorState, now: number): number {
  const tz = deps.settings.get().timezone
  const day = localDay(now, tz)
  return state.retries.filter((r) => localDay(r.at, tz) === day).length
}

/** The connections the agent uses now (enabled for it). */
async function agentConnections(
  deps: Deps,
  agentId: string,
): Promise<Array<{ id: string; label: string; status: string; statusMessage?: string }>> {
  const agent = deps.agents.get(agentId)
  if (agent === undefined) return []
  try {
    return (await deps.connectors.agentConnectors(agent))
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.connectionId,
        label: c.label,
        status: c.status,
        ...(c.statusMessage === undefined ? {} : { statusMessage: c.statusMessage }),
      }))
  } catch {
    return []
  }
}

/** What unacknowledged alarms already tell the owner (P54): the supervisor does not repeat it. */
function alarmedBy(deps: Deps): { tasks: Set<string>; connections: Set<string> } {
  const tasks = new Set<string>()
  const connections = new Set<string>()
  for (const a of openAlarms(deps)) {
    if (a.kind === 'run-failed' || a.kind === 'run-stuck') {
      for (const r of a.refs) if (r.startsWith('/tasks/')) tasks.add(r.slice('/tasks/'.length))
    } else if (a.kind === 'connection-broken') {
      connections.add(a.subject.slice('connection:'.length))
    }
  }
  return { tasks, connections }
}

export interface Supervision {
  /** What the beat is told (new or changed since it was last shown; all of it in a deep review). */
  items: SupervisorItem[]
  /** Items left out for space. */
  more: number
  /** The beat may edit its own memory (its list has memory findings). */
  memoryFix: boolean
  /** The Monday deep review runs in this beat. */
  deep: boolean
}

/**
 * Look at the work of one agent. `deep`: the first schedule beat of a Monday (team timezone) lists
 * every consistency finding, new or not, once per week.
 */
export async function supervise(deps: Deps, agentId: string, now: number): Promise<Supervision> {
  const agent = getAgent(deps, agentId)
  const tz = deps.settings.get().timezone
  const state = stateOf(deps, agent.id)
  const deep = isMonday(now, tz) && state.deepWeek !== mondayOf(now, tz)

  const connections = await agentConnections(deps, agent.id)
  const superseded = (t: { id: string; sessionId: string; endedAt: number | null }): boolean => {
    const pid = parseProgramSession(t.sessionId)?.programId
    if (pid === undefined) return false
    const newest = deps.tasks.ofProgram(pid, 3)[0]
    return newest !== undefined && newest.id !== t.id && newest.status === 'done'
  }
  const observed = superviseObservation({
    now,
    tasks: deps.tasks.list({ agentId: agent.id, limit: 300 }),
    parked: sessionsWithOpenDecision(deps),
    superseded,
    decisions: deps.decisions.list({ status: 'open', agentId: agent.id, limit: 100 }),
    connections,
    state,
    retriesToday: retriesToday(deps, state, now),
    alarmed: alarmedBy(deps),
  })

  let findings: ConsistencyLike[] = []
  try {
    findings = await consistencyFindings(deps, { agentId: agent.id, now })
  } catch {
    // a failed scan never stops a beat: the deterministic part still runs
  }
  const consistency: SupervisorItem[] = findings.map((f) => ({
    kind: 'consistency',
    fingerprint: `supervisor:consistency:${f.fingerprint}`,
    title: `${f.subject}`,
    detail: f.explanation,
    links: f.refs.slice(0, 4),
    finding: f,
  }))

  const fresh = (i: SupervisorItem): boolean => {
    const at = state.seen[i.fingerprint]
    return at === undefined || now - at >= SUPERVISOR_SEEN_MS
  }
  const all = [
    ...observed.filter(fresh),
    // the deep review lists every finding; otherwise only what changed since a beat last saw it
    ...(deep ? consistency : consistency.filter(fresh)),
  ]
  const items = all.slice(0, MAX_SUPERVISOR_ITEMS)
  return {
    items,
    more: all.length - items.length,
    memoryFix: items.some((i) => i.finding !== undefined && isMemoryFinding(i.finding)),
    deep,
  }
}

/** What the beat prompt needs of a supervision. */
export const promptOf = (agentId: string, s: Supervision): SupervisorPrompt => ({
  items: s.items,
  more: s.more,
  memoryFix: s.memoryFix,
  deep: s.deep,
  memoryDir: agentMemory(agentId),
})

/** A beat starts with this supervision: remember what it was shown and what it may do. */
export function beginSupervision(deps: Deps, agentId: string, s: Supervision, now: number): void {
  const week = mondayOf(now, deps.settings.get().timezone)
  setSupervisor(deps, agentId, now, (cur) => ({
    ...cur,
    seen: { ...cur.seen, ...Object.fromEntries(s.items.map((i) => [i.fingerprint, now])) },
    memoryFix: s.memoryFix,
    memoryChanges: [],
    ...(s.deep ? { deepWeek: week } : {}),
  }))
}

/** A beat that does not look at the supervisor (a deadline or activity beat) edits no memory. */
export function clearSupervision(deps: Deps, agentId: string, now: number): void {
  if (stateOf(deps, agentId).memoryFix !== true) return
  setSupervisor(deps, agentId, now, (cur) => ({ ...cur, memoryFix: false }))
}

/** Is the running beat allowed to edit its own memory? Read by the gate on every call. */
export const memoryFixOpen = (deps: Deps, agentId: string): boolean =>
  stateOf(deps, agentId).memoryFix === true

/** The Monday deep review has nothing to do on its own: mark the week as reviewed. */
export function markDeepDone(deps: Deps, agentId: string, now: number): void {
  const week = mondayOf(now, deps.settings.get().timezone)
  if (stateOf(deps, agentId).deepWeek === week) return
  setSupervisor(deps, agentId, now, (cur) => ({ ...cur, deepWeek: week }))
}

// --- the tools ---------------------------------------------------------------------------------

/**
 * `heartbeat_retry_run`: continue a failed run of the agent's own, from where it stopped. Refused
 * (a sentence the beat can read) for another agent's run, a run that did not fail, a failure a
 * retry cannot change, a run the supervisor already retried, and over three a day.
 */
export async function retryRun(
  deps: Deps,
  agentId: string,
  taskId: string,
  reason: string,
  now: number,
): Promise<string> {
  const task = deps.tasks.get(taskId)
  if (task === undefined) return `Not retried: there is no run ${taskId}.`
  if (task.agentId !== agentId) {
    return `Not retried: ${taskId} is not one of your own runs (a beat re-runs only its own agent's work).`
  }
  if (task.status === 'running' || task.status === 'needs_action' || task.status === 'queued') {
    return `Not retried: the run is ${task.status}; it did not fail.`
  }
  if (task.status === 'retrying') {
    return 'Not retried: the run waits for its automatic retry; leave it alone.'
  }
  if (!['failed', 'interrupted', 'timed_out'].includes(task.status)) {
    return `Not retried: the run ended ${task.status}, not failed.`
  }
  const state = stateOf(deps, agentId)
  const connections = await agentConnections(deps, agentId)
  const verdict = retryVerdict({
    failure: classifyRunFailure(task.summary),
    retriesToday: retriesToday(deps, state, now),
    alreadyRetried: state.retries.some((r) => r.taskId === taskId),
    connectionsHealthy: connections.every((c) => c.status !== 'error' && c.status !== 'needs-auth'),
  })
  if (!verdict.ok) return `Not retried: ${verdict.reason}.`
  if (reason.trim() === '') return 'Not retried: say why a retry should help (a reason).'
  try {
    await retryTask(deps, taskId)
  } catch (error) {
    return `Not retried: ${error instanceof Error ? error.message : String(error)}`
  }
  setSupervisor(deps, agentId, now, (cur) => ({
    ...cur,
    retries: [...cur.retries, { taskId, at: now }],
  }))
  return `Retry started for "${task.title}" (${verdict.left - 1} retries left today). It continues from where it stopped; if it fails again you will see it in a later beat and must escalate.`
}

export interface OwnerQuestion {
  title: string
  /** What failed or is inconsistent, and why you think so. */
  diagnosis: string
  /** The concrete action the owner can take. */
  fix: string
  options?: string[] | undefined
  /** The fingerprint of the supervisor item (for the body only). */
  fingerprint?: string | undefined
}

/**
 * `heartbeat_ask_owner`: one Decision Center question with the diagnosis and the concrete fix. One
 * open question per title, five a day per agent; it never changes anything by itself.
 */
export function askOwner(deps: Deps, agentId: string, q: OwnerQuestion, now: number): string {
  const agent = getAgent(deps, agentId)
  if (q.title.trim() === '' || q.diagnosis.trim() === '' || q.fix.trim() === '') {
    return 'Not asked: a question needs a title, a diagnosis and the concrete fix.'
  }
  const title = checkTitle(`${SUPERVISOR_TITLE_PREFIX}${agent.name}: ${q.title}`.slice(0, 200))
  const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 200 })
  if (open.some((d) => d.title === title)) {
    return 'Not asked: the owners already have this question open.'
  }
  const { dayStart } = periodStarts(now, deps.settings.get().timezone)
  const today = deps.decisions
    .list({ agentId: agent.id, limit: 200 })
    .filter((d) => d.title.startsWith(SUPERVISOR_TITLE_PREFIX) && d.createdAt >= dayStart)
  if (today.length >= MAX_SUPERVISOR_QUESTIONS_PER_DAY) {
    return `Not asked: ${MAX_SUPERVISOR_QUESTIONS_PER_DAY} supervisor questions were already raised today; put it in your result instead.`
  }
  const options = (q.options ?? []).map((o) => o.trim()).filter((o) => o !== '')
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'escalation',
    title,
    body: checkBody(
      [
        `Diagnosis: ${q.diagnosis.trim()}`,
        '',
        `Suggested action: ${q.fix.trim()}`,
        ...(q.fingerprint === undefined ? [] : ['', `(supervisor item ${q.fingerprint})`]),
      ].join('\n'),
    ),
    agentId: agent.id,
    sessionId: null,
    programId: null,
    payload: {
      question: q.title.trim().slice(0, 300),
      options: options.length >= 2 ? options.slice(0, 5) : ['I will do it', 'Ignore this'],
      source: 'report',
    },
    waitId: null,
    createdAt: now,
  })
  changed(deps, d, 'created')
  return 'Asked the owners in the Decision Center.'
}

// --- memory edits of a beat --------------------------------------------------------------------

/** A memory tool of the running beat changed a file: keep it for the beat log and the digest. */
export function recordMemoryChange(
  deps: Deps,
  agentId: string,
  call: { toolName: string; input: unknown },
  now: number,
): void {
  const change = memoryChangeOf(call)
  if (change === undefined) return
  setSupervisor(deps, agentId, now, (cur) => ({
    ...cur,
    memoryChanges: [...(cur.memoryChanges ?? []), { at: now, ...change }].slice(-50),
  }))
}

/** The memory edits of the beat that just ended (and forget them). */
export function takeMemoryChanges(
  deps: Deps,
  agentId: string,
  now: number,
): NonNullable<SupervisorState['memoryChanges']> {
  const changes = stateOf(deps, agentId).memoryChanges ?? []
  if (changes.length > 0 || stateOf(deps, agentId).memoryFix === true) {
    setSupervisor(deps, agentId, now, (cur) => ({ ...cur, memoryChanges: [], memoryFix: false }))
  }
  return changes
}
