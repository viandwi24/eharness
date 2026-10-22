/**
 * Alarms (docs/plans/P54-alarms.md): scheduled or background work that failed must never stay
 * silent. An alarm is one stored incident with a plain text (what failed, why, the one next step),
 * shown on the Needs attention page until acknowledged and pushed to the owner. Everything here is
 * deterministic and pure; no model writes an alarm.
 */

export const ALARM_KINDS = [
  'run-failed',
  'run-stuck',
  'routine-paused',
  'approval-expired',
  'connection-broken',
  'system',
] as const
export type AlarmKind = (typeof ALARM_KINDS)[number]

export interface Alarm {
  id: string
  kind: AlarmKind
  /** The incident: a run id, a routine pause, an approval id. The same key is never raised twice. */
  key: string
  /** What it is about (`program:<id>`, `routine:<id>`, `connection:<id>`, `system:<step>`). */
  subject: string
  agentId: string | null
  /** Plain short text: what failed, why, and the one next step. */
  text: string
  /** App paths that open the evidence or the fix (the first is the primary link). */
  refs: string[]
  createdAt: number
  /** Set when acknowledged; the record stays for history. */
  ackedAt: number | null
  /** `owner` (the Ack button) or `auto` (the cause cleared). */
  ackedBy: 'owner' | 'auto' | null
  /** When it reached the owner (chat message or bell). Null: waiting for its turn. */
  deliveredAt: number | null
}

export interface NewAlarm {
  kind: AlarmKind
  key: string
  subject: string
  agentId?: string | null
  text: string
  refs?: string[]
}

/** At most one message per subject per this long; the rest waits and goes out as one batch. */
export const ALARM_RATE_MS = 10 * 60_000
/** Alarms in one batched message before it says "and N more". */
export const ALARM_BATCH_LINES = 8
/** A run with no activity for this many minutes is stuck (setting `stuckRunMinutes`). */
export const DEFAULT_STUCK_MINUTES = 45
export const MIN_STUCK_MINUTES = 5
export const MAX_STUCK_MINUTES = 24 * 60
/** Runs that ended this long ago are not raised by the sweep (the first sweep after a long outage). */
export const ALARM_RUN_WINDOW_MS = 6 * 3_600_000

export const isAlarmKind = (value: string): value is AlarmKind =>
  (ALARM_KINDS as readonly string[]).includes(value)

// --- texts ---------------------------------------------------------------------------------------

const oneLine = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** A run ended failed, interrupted or timed out and its automatic retries are used up. */
export function runFailedText(input: {
  title: string
  status: string
  why: string | null
  /** A program run: its name. */
  program?: string | undefined
}): string {
  const what = input.program === undefined ? `"${input.title}"` : `program "${input.program}"`
  const outcome =
    input.status === 'timed_out'
      ? 'timed out'
      : input.status === 'interrupted'
        ? 'was interrupted'
        : 'failed'
  const why = input.why === null || input.why.trim() === '' ? 'No reason was recorded.' : input.why
  return `The run of ${what} ${outcome}. Why: ${oneLine(why, 300)} Next: open the run and press Retry once the cause is fixed.`
}

export function runStuckText(input: {
  title: string
  program?: string | undefined
  idleMinutes: number
}): string {
  const what = input.program === undefined ? `"${input.title}"` : `program "${input.program}"`
  return `The run of ${what} showed no activity for ${input.idleMinutes} minutes, so it was stopped (nothing is run again by itself). Next: open the run, look at its last step and press Retry if it should continue.`
}

export function routinePausedText(input: {
  name: string
  failures: number
  reason: string
}): string {
  // failures 0: it cannot run at all (a configuration problem), so no run failed
  if (input.failures === 0)
    return `"${input.name}" cannot run, so its schedule is paused. Why: ${oneLine(input.reason, 300)} Next: fix the cause, then resume it.`
  return `Routine "${input.name}" paused itself after ${input.failures} failed runs in a row. Why: ${oneLine(input.reason, 300)} Next: fix the cause, then resume it (a program on the Programs page).`
}

export function approvalExpiredText(input: { tool: string; where: string; agent: string }): string {
  return `${input.agent} asked to use ${input.tool} in ${input.where} and nobody answered in time, so the call was declined and the work did not finish. Next: open the conversation and ask the agent to try again, then approve it.`
}

export function connectionBrokenText(input: {
  label: string
  status: string
  message?: string | undefined
}): string {
  const state = input.status === 'needs-auth' ? 'needs you to sign in again' : 'is in error'
  const why =
    input.message === undefined || input.message === ''
      ? ''
      : ` Why: ${oneLine(input.message, 240)}`
  return `The connection "${input.label}" ${state}, so agents that use it cannot work with it.${why} Next: reconnect it on the Connectors page.`
}

export function systemText(input: { step: string; error: string }): string {
  return `The server step "${input.step}" failed. Why: ${oneLine(input.error, 300)} Next: look at the server log; this repeats at the next start until it is fixed.`
}

// --- delivery ------------------------------------------------------------------------------------

/** A subject that was delivered to the owner recently. */
export interface RecentDelivery {
  subject: string
  deliveredAt: number
}

/**
 * Which pending alarms may go out now: a subject that got a message within the rate window waits.
 * Two pending alarms of the same subject go out together (one batch), not one after the other.
 */
export function dueAlarms(
  pending: readonly Alarm[],
  recent: readonly RecentDelivery[],
  now: number,
): Alarm[] {
  const blocked = new Set(
    recent.filter((r) => now - r.deliveredAt < ALARM_RATE_MS).map((r) => r.subject),
  )
  return pending.filter((a) => a.ackedAt === null && !blocked.has(a.subject))
}

/** The message the owner reads for one alarm or a batch. `link(ref)` makes a ref clickable. */
export function pushText(alarms: readonly Alarm[], link: (ref: string) => string): string {
  const first = alarms[0]
  if (first === undefined) return ''
  const open = (a: Alarm): string => (a.refs[0] === undefined ? '' : ` ${link(a.refs[0])}`)
  if (alarms.length === 1) return `Needs attention: ${first.text}${open(first)}`
  const lines = alarms.slice(0, ALARM_BATCH_LINES).map((a) => `- ${a.text}${open(a)}`)
  const more = alarms.length - lines.length
  return `${alarms.length} things need attention:\n${lines.join('\n')}${more > 0 ? `\n...and ${more} more on the Needs attention page.` : ''}`
}

// --- stuck runs ----------------------------------------------------------------------------------

export interface RunFact {
  id: string
  sessionId: string
  status: string
  lastActivityAt: number
}

/**
 * The runs `running` whose turn showed no activity for `limitMs`. A run parked on an open decision
 * is waiting for a person, not stuck.
 */
export function stuckRuns<T extends RunFact>(
  runs: readonly T[],
  input: { now: number; limitMs: number; parked: ReadonlySet<string> },
): T[] {
  return runs.filter(
    (r) =>
      r.status === 'running' &&
      !input.parked.has(r.sessionId) &&
      input.now - r.lastActivityAt >= input.limitMs,
  )
}

export const stuckLimitMs = (minutes: number | undefined): number =>
  Math.min(Math.max(minutes ?? DEFAULT_STUCK_MINUTES, MIN_STUCK_MINUTES), MAX_STUCK_MINUTES) *
  60_000
