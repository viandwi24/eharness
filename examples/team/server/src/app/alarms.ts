/**
 * Alarms (docs/plans/P54-alarms.md): no failure of scheduled or background work stays silent.
 *
 * Sources raise an alarm (`raiseAlarm`, one per incident key): a run that ended failed,
 * interrupted or timed out for good, a stuck run (interrupted here), a routine that paused itself,
 * an approval nobody answered, a broken connection, a failed startup or health step. The sweep
 * (`sweepAlarms`, every minute and on demand) finds the ones nobody reports as an event and clears
 * the alarms whose cause is gone. Delivery (`deliverAlarms`) pushes a plain text to the owner's
 * chat, rate limited per subject and batched, and falls back to the bell. No model call anywhere.
 */
import {
  ALARM_RATE_MS,
  ALARM_RUN_WINDOW_MS,
  type Alarm,
  approvalExpiredText,
  connectionBrokenText,
  dueAlarms,
  type NewAlarm,
  pushText,
  routinePausedText,
  runFailedText,
  runStuckText,
  stuckLimitMs,
  stuckRuns,
  systemText,
} from '../domain/alarms.ts'
import { notFound } from '../domain/errors.ts'
import { localDay } from '../domain/heartbeat.ts'
import { parseProgramSession } from '../domain/programs.ts'
import { parseRoutineSession } from '../domain/routines.ts'
import { isWorkItem, type Task } from '../domain/tasks.ts'
import { postNotice } from './briefings.ts'
import type { Deps } from './ports.ts'
import { sessionsWithOpenDecision } from './work-queue.ts'

/** The bell shows the first sentence of the alarm as its title (the full text is the body). */
const bellTitle = (a: Alarm): string => {
  const first = a.text.split(/\.\s/)[0] ?? a.text
  return first.slice(0, 160)
}

const warn = (message: string): void => console.warn(`team: alarms: ${message}`)

const changed = (deps: Deps, payload: Record<string, unknown>): void => {
  try {
    deps.events.append({ type: 'notification-changed', payload: { kind: 'alarm', ...payload } })
  } catch (error) {
    warn(`could not tell the feed: ${String(error)}`)
  }
}

// --- raising -------------------------------------------------------------------------------------

/**
 * Store one alarm per incident (`input.key`) and start its delivery. undefined: that incident was
 * raised before (nothing is stored or sent twice).
 */
export function raiseAlarm(deps: Deps, input: NewAlarm): Alarm | undefined {
  const alarm = deps.alarms.insert({
    ...input,
    id: deps.ids.next(),
    createdAt: deps.clock.now(),
  })
  if (alarm === undefined) return undefined
  changed(deps, { added: alarm.id })
  try {
    deps.events.append({
      type: 'alarm-raised',
      ...(alarm.agentId === null ? {} : { agentId: alarm.agentId }),
      payload: {
        alarmId: alarm.id,
        kind: alarm.kind,
        subject: alarm.subject,
        text: bellTitle(alarm),
        ...(alarm.subject.startsWith('program:')
          ? { program: deps.programs.get(alarm.subject.slice('program:'.length))?.name }
          : {}),
      },
    })
  } catch (error) {
    warn(`could not tell the feed about the alarm: ${String(error)}`)
  }
  void deliverAlarms(deps).catch((error) => warn(`delivery failed: ${String(error)}`))
  return alarm
}

/**
 * An incident that can happen again for the same subject (a connection breaks, is fixed, breaks
 * again): none while the last one is still open, otherwise a new key.
 */
export function raiseRecurring(deps: Deps, input: NewAlarm): Alarm | undefined {
  if (deps.alarms.openOf(input.subject, input.kind).length > 0) return undefined
  const n = deps.alarms.countOf(input.subject, input.kind)
  return raiseAlarm(deps, { ...input, key: `${input.key}:${n}` })
}

/** A failed server step: a logged warning and a `system` alarm (one per step and local day). */
export function raiseSystemAlarm(deps: Deps, step: string, error: unknown): Alarm | undefined {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`team: ${step} failed: ${message}`)
  try {
    const day = localDay(deps.clock.now(), deps.settings.get().timezone)
    return raiseAlarm(deps, {
      kind: 'system',
      key: `system:${step}:${day}`,
      subject: `system:${step}`,
      text: systemText({ step, error: message }),
      refs: ['/attention'],
    })
  } catch (alarmError) {
    // the alarm itself cannot be stored (the database is the problem): the log line above is all
    console.warn(`team: alarm for ${step} not stored: ${String(alarmError)}`)
    return undefined
  }
}

/** A routine paused itself (too many failures, or it cannot run at all). */
export function raiseRoutinePaused(
  deps: Deps,
  input: {
    routineId: string
    name: string
    agentId: string
    failures: number
    reason: string
    /** The run that tipped it, or the pause time: part of the incident key. */
    incident: string
    link: string
  },
): Alarm | undefined {
  return raiseAlarm(deps, {
    kind: 'routine-paused',
    key: `routine-paused:${input.routineId}:${input.incident}`,
    subject: `routine:${input.routineId}`,
    agentId: input.agentId,
    text: routinePausedText(input),
    refs: [input.link],
  })
}

/** An approval nobody answered was declined: the work behind it did not finish. */
export function raiseApprovalExpired(
  deps: Deps,
  input: { approvalId: string; sessionId: string; agentId: string; tool: string; where: string },
): Alarm | undefined {
  const agent = deps.agents.get(input.agentId)
  const task = deps.tasks.getBySession(input.sessionId)
  return raiseAlarm(deps, {
    kind: 'approval-expired',
    key: `approval:${input.approvalId}`,
    subject: `session:${input.sessionId}`,
    agentId: input.agentId,
    text: approvalExpiredText({
      tool: input.tool,
      where: input.where,
      agent: agent?.name ?? 'An agent',
    }),
    refs: [task === undefined ? `/a/${input.agentId}` : `/tasks/${task.id}`],
  })
}

/** A connection went to error or needs the owner to sign in again. */
export function raiseConnectionBroken(
  deps: Deps,
  input: { id: string; label: string; status: string; message?: string | undefined },
): Alarm | undefined {
  return raiseRecurring(deps, {
    kind: 'connection-broken',
    key: `connection:${input.id}`,
    subject: `connection:${input.id}`,
    text: connectionBrokenText(input),
    refs: ['/connectors'],
  })
}

// --- the sweep -----------------------------------------------------------------------------------

const FAILED_STATES = ['failed', 'interrupted', 'timed_out'] as const

/** Background work: program and routine runs, and tasks that came through the work queue. */
const isBackground = (t: Task): boolean =>
  t.origin === 'program' || t.origin === 'routine' || isWorkItem(t)

function subjectOf(task: Task): string {
  const program = parseProgramSession(task.sessionId)
  if (program !== undefined) return `program:${program.programId}`
  const routine = parseRoutineSession(task.sessionId)
  if (routine !== undefined) return `routine:${routine.routineId}`
  return `task:${task.id}`
}

function programNameOf(deps: Deps, task: Task): string | undefined {
  const pid = parseProgramSession(task.sessionId)?.programId
  return pid === undefined ? undefined : deps.programs.get(pid)?.name
}

function refsOf(task: Task): string[] {
  const pid = parseProgramSession(task.sessionId)?.programId
  return [`/tasks/${task.id}`, ...(pid === undefined ? [] : [`/programs/${pid}`])]
}

/** Runs that ended for good (no automatic retry waits) and are not covered by a later good run. */
function raiseFailedRuns(deps: Deps, now: number): number {
  let raised = 0
  for (const status of FAILED_STATES) {
    for (const task of deps.tasks.list({ status, limit: 200 })) {
      if (task.endedAt === null || now - task.endedAt > ALARM_RUN_WINDOW_MS) continue
      if (!isBackground(task)) continue
      // the run was stopped by the stuck-run check: that alarm already says so
      if (deps.alarms.byKey(`stuck:${task.id}`) !== undefined) continue
      if (deps.turnRetry.pending(task.sessionId) !== undefined) continue
      const pid = parseProgramSession(task.sessionId)?.programId
      if (pid !== undefined) {
        const newest = deps.tasks.ofProgram(pid, 3)[0]
        if (newest !== undefined && newest.id !== task.id && newest.status === 'done') continue
      }
      const program = programNameOf(deps, task)
      const alarm = raiseAlarm(deps, {
        kind: 'run-failed',
        key: `run:${task.id}:${task.endedAt}`,
        subject: subjectOf(task),
        agentId: task.agentId,
        text: runFailedText({ title: task.title, status: task.status, why: task.summary, program }),
        refs: refsOf(task),
      })
      if (alarm !== undefined) raised++
    }
  }
  return raised
}

/**
 * Runs `running` with no activity for the limit (setting `stuckRunMinutes`) are interrupted through
 * the Stop path (in-flight tool calls get `Interrupted:` results, ADR-0014) and alarmed. They are
 * never run again by themselves.
 */
async function interruptStuckRuns(deps: Deps, now: number): Promise<number> {
  const minutes = deps.settings.get().stuckRunMinutes
  const limitMs = stuckLimitMs(minutes)
  const running = deps.tasks.list({ status: 'running', limit: 300 }).filter(isBackground)
  const stuck = stuckRuns(running, { now, limitMs, parked: sessionsWithOpenDecision(deps) })
  let n = 0
  for (const task of stuck) {
    if (deps.alarms.byKey(`stuck:${task.id}`) !== undefined) continue
    const idle = Math.round((now - task.lastActivityAt) / 60_000)
    // the alarm first: even when the abort fails the owner knows
    const alarm = raiseAlarm(deps, {
      kind: 'run-stuck',
      key: `stuck:${task.id}`,
      subject: subjectOf(task),
      agentId: task.agentId,
      text: runStuckText({
        title: task.title,
        program: programNameOf(deps, task),
        idleMinutes: idle,
      }),
      refs: refsOf(task),
    })
    if (alarm === undefined) continue
    n++
    try {
      await deps.interruptRun?.(task, 'stuck')
    } catch (error) {
      warn(`could not interrupt ${task.id}: ${String(error)}`)
    }
  }
  return n
}

/**
 * A connection must stay broken this long before the owner is told: the background health probe
 * tests custom MCP servers about every minute, and one dropped socket or slow listing flips the
 * status to `error` until the next probe (a single dropped socket must not alarm). `needs-auth` waits less: it does not heal by itself.
 */
export const CONNECTION_GRACE_MS = 10 * 60_000
export const CONNECTION_AUTH_GRACE_MS = 2 * 60_000
/** A connection that already alarmed within this window is not announced again (flapping). */
export const CONNECTION_REALARM_MS = 24 * 3_600_000

/** When each connection was first seen broken in this run of broken sweeps (per server). */
const brokenSince = new WeakMap<object, Map<string, number>>()

async function raiseBrokenConnections(deps: Deps, now: number): Promise<number> {
  let since = brokenSince.get(deps)
  if (since === undefined) {
    since = new Map()
    brokenSince.set(deps, since)
  }
  let n = 0
  const recent = deps.alarms
    .list({ open: false, limit: 500 })
    .filter((a) => a.kind === 'connection-broken' && now - a.createdAt < CONNECTION_REALARM_MS)
  const seen = new Set<string>()
  for (const c of await deps.connectors.connections()) {
    if (c.status !== 'error' && c.status !== 'needs-auth') continue
    seen.add(c.id)
    const first = since.get(c.id) ?? now
    since.set(c.id, first)
    const grace = c.status === 'needs-auth' ? CONNECTION_AUTH_GRACE_MS : CONNECTION_GRACE_MS
    if (now - first < grace) continue
    // it broke, healed and broke again today: the earlier alarm said it; the Needs attention page shows it
    if (recent.some((a) => a.subject === `connection:${c.id}`)) continue
    const alarm = raiseConnectionBroken(deps, {
      id: c.id,
      label: c.label,
      status: c.status,
      message: c.statusMessage,
    })
    if (alarm !== undefined) n++
  }
  for (const id of [...since.keys()]) if (!seen.has(id)) since.delete(id)
  return n
}

/** Is the cause of this alarm gone? Only alarms whose cause can be read are ever cleared. */
async function causeCleared(
  deps: Deps,
  alarm: Alarm,
  connections: ReadonlyMap<string, string>,
): Promise<boolean> {
  const [what, id] = [
    alarm.subject.split(':')[0],
    alarm.subject.slice(alarm.subject.indexOf(':') + 1),
  ]
  if (alarm.kind === 'connection-broken') {
    return connections.get(id) === 'connected'
  }
  if (alarm.kind === 'routine-paused') {
    const routine = deps.routines.get(id)
    return routine === undefined || routine.status !== 'paused'
  }
  if (alarm.kind === 'run-failed' || alarm.kind === 'run-stuck') {
    const taskId = (alarm.refs[0] ?? '').replace('/tasks/', '')
    const task = deps.tasks.get(taskId)
    if (task === undefined) return false
    // retried and fine (or running again, or waiting for its automatic retry). A stuck run that is
    // still `running` is cleared only by new activity after the alarm (the interrupt may have failed).
    if (task.status === 'running') {
      return alarm.kind === 'run-failed' || task.lastActivityAt > alarm.createdAt
    }
    if (['done', 'retrying', 'queued'].includes(task.status)) return true
    if (what === 'program') {
      const newest = deps.tasks.ofProgram(id, 1)[0]
      return newest !== undefined && newest.id !== task.id && newest.status === 'done'
    }
    return false
  }
  return false
}

/** Acknowledge (as `auto`) the open alarms whose cause is gone. The records stay. */
export async function clearAlarms(deps: Deps, now: number): Promise<number> {
  const open = deps.alarms.list({ open: true, limit: 500 })
  if (open.length === 0) return 0
  const connections = new Map<string, string>()
  if (open.some((a) => a.kind === 'connection-broken')) {
    for (const c of await deps.connectors.connections()) connections.set(c.id, c.status)
  }
  let n = 0
  for (const alarm of open) {
    if (!(await causeCleared(deps, alarm, connections))) continue
    if (deps.alarms.ack(alarm.id, 'auto', now) !== undefined) {
      deps.notifications.dismissByKeyPrefix(`alarm:${alarm.id}`, now)
      n++
    }
  }
  if (n > 0) changed(deps, { cleared: n })
  return n
}

export interface SweepReport {
  failedRuns: number
  stuck: number
  connections: number
  cleared: number
}

/** One pass: raise what no event reports, clear what is fixed, deliver what is waiting. */
export async function sweepAlarms(
  deps: Deps,
  now: number = deps.clock.now(),
): Promise<SweepReport> {
  const failedRuns = raiseFailedRuns(deps, now)
  const stuck = await interruptStuckRuns(deps, now)
  let connections = 0
  try {
    connections = await raiseBrokenConnections(deps, now)
  } catch (error) {
    warn(`connections unreadable: ${String(error)}`)
  }
  const cleared = await clearAlarms(deps, now)
  await deliverAlarms(deps, now)
  return { failedRuns, stuck, connections, cleared }
}

// --- delivery ------------------------------------------------------------------------------------

const chains = new WeakMap<object, Promise<unknown>>()

/**
 * Push what is waiting: one message for the alarms due now (rate limit per subject, the rest waits
 * and goes out in a later batch). No chat destination: the bell. One delivery at a time.
 */
export function deliverAlarms(
  deps: Deps,
  now: number = deps.clock.now(),
): Promise<{ delivered: number; via: 'chat' | 'bell' | 'none' }> {
  const run = async (): Promise<{ delivered: number; via: 'chat' | 'bell' | 'none' }> => {
    const pending = deps.alarms.pending()
    if (pending.length === 0) return { delivered: 0, via: 'none' }
    const due = dueAlarms(pending, deps.alarms.deliveredSince(now - ALARM_RATE_MS), now)
    if (due.length === 0) return { delivered: 0, via: 'none' }
    const base = deps.webUrl.replace(/\/+$/, '')
    const text = pushText(due, (ref) => `${base}${ref}`)
    let via: 'chat' | 'bell' = 'bell'
    if (deps.alarmPush !== undefined) {
      try {
        if ((await deps.alarmPush.push(text)) === 'sent') via = 'chat'
      } catch (error) {
        warn(`push failed, using the bell: ${String(error)}`)
      }
    }
    if (via === 'bell') {
      for (const a of due) {
        postNotice(deps, {
          key: `alarm:${a.id}`,
          title: bellTitle(a),
          body: a.text,
          link: a.refs[0] ?? '/attention',
          agentId: a.agentId,
          at: now,
        })
      }
    }
    deps.alarms.markDelivered(
      due.map((a) => a.id),
      now,
    )
    changed(deps, { delivered: due.length, via })
    return { delivered: due.length, via }
  }
  const prev = chains.get(deps) ?? Promise.resolve()
  const next = prev.then(run, run)
  chains.set(
    deps,
    next.catch(() => undefined),
  )
  return next
}

// --- reading and acknowledging -------------------------------------------------------------------

export function listAlarms(deps: Deps, opts: { all?: boolean; limit?: number } = {}) {
  return {
    alarms: deps.alarms.list({ open: opts.all !== true, limit: opts.limit ?? 100 }),
    open: deps.alarms.countOpen(),
  }
}

export function ackAlarm(deps: Deps, id: string): Alarm {
  if (deps.alarms.get(id) === undefined) throw notFound('alarm', id)
  const now = deps.clock.now()
  const next = deps.alarms.ack(id, 'owner', now) as Alarm
  deps.notifications.dismissByKeyPrefix(`alarm:${id}`, now)
  changed(deps, { acked: id })
  return next
}

/** Unacknowledged alarms: what the supervisor reads instead of telling the owner again. */
export const openAlarms = (deps: Deps): Alarm[] => deps.alarms.list({ open: true, limit: 500 })
