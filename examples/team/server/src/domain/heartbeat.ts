/**
 * Heartbeat and daily digest (docs/plans/P40-team-autonomous-operations.md, D9 and D10). Pure.
 *
 * The heartbeat is the ambient monitor of an agent: one rolling session `heartbeat:<agentId>` that a
 * routine wakes every N minutes inside the agent's active hours. It is silent by default: a beat
 * that finds nothing ends `ok` and shows nothing. What it finds (`attention`) is deduplicated by a
 * fingerprint, queued in the digest buffer, and only an urgent finding interrupts the client, as
 * one short message in the lead's DM. The server computes the observations (`observe`) so the model
 * reads a compact summary instead of crawling the app; the checklist file in the agent's memory
 * (`HEARTBEAT.md`) says what else to look at, and an empty one means no model call at all.
 *
 * The daily digest (`buildDigest`) is built from data, not by a model, so it is cheap and reliable.
 */

import type { BriefingItem } from './briefings.ts'
import type { Decision } from './decisions.ts'
import { invalid } from './errors.ts'
import { agentMemory } from './memory.ts'
import { type Program, parseProgramSession } from './programs.ts'
import type { Routine } from './routines.ts'
import type { Task } from './tasks.ts'

// --- configuration -----------------------------------------------------------------------------

export interface HeartbeatConfig {
  enabled: boolean
  /** Minutes between beats. */
  everyMinutes: number
  /** Active hours, `HH:MM` in `timezone`; a window that wraps midnight is fine. */
  activeFrom: string
  activeTo: string
  /** IANA timezone of the active hours; null = the team timezone (the workspace setting). */
  timezone: string | null
}

export const DEFAULT_EVERY_MINUTES = 30
export const MIN_EVERY_MINUTES = 5
export const MAX_EVERY_MINUTES = 24 * 60

export const DEFAULT_HEARTBEAT: Omit<HeartbeatConfig, 'enabled'> = {
  everyMinutes: DEFAULT_EVERY_MINUTES,
  activeFrom: '08:00',
  activeTo: '20:00',
  timezone: null,
}

/** On by default for the lead (the manager) only. */
export const defaultHeartbeat = (agent: { role: string }): HeartbeatConfig => ({
  enabled: agent.role === 'lead',
  ...DEFAULT_HEARTBEAT,
})

export interface DigestConfig {
  enabled: boolean
  /** `HH:MM` in `timezone`. */
  time: string
  /** IANA timezone; null = the team timezone (the workspace setting). */
  timezone: string | null
}

export const DEFAULT_DIGEST: DigestConfig = { enabled: true, time: '18:00', timezone: null }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export const isClock = (value: string): boolean => HHMM.test(value)

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function checkHeartbeatFields(f: Partial<HeartbeatConfig>): void {
  if (f.everyMinutes !== undefined) {
    if (
      !Number.isInteger(f.everyMinutes) ||
      f.everyMinutes < MIN_EVERY_MINUTES ||
      f.everyMinutes > MAX_EVERY_MINUTES
    ) {
      throw invalid(
        `everyMinutes must be an integer from ${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES}`,
        'INVALID_HEARTBEAT',
      )
    }
  }
  for (const [name, value] of [
    ['activeFrom', f.activeFrom],
    ['activeTo', f.activeTo],
  ] as const) {
    if (value !== undefined && !isClock(value)) {
      throw invalid(`${name} must be HH:MM (24 hours)`, 'INVALID_HEARTBEAT')
    }
  }
  if (f.timezone != null && !isTimezone(f.timezone)) {
    throw invalid(`unknown timezone: ${f.timezone}`, 'INVALID_HEARTBEAT')
  }
}

export function checkDigestFields(f: Partial<DigestConfig>): void {
  if (f.time !== undefined && !isClock(f.time)) {
    throw invalid('time must be HH:MM (24 hours)', 'INVALID_HEARTBEAT')
  }
  if (f.timezone != null && !isTimezone(f.timezone)) {
    throw invalid(`unknown timezone: ${f.timezone}`, 'INVALID_HEARTBEAT')
  }
}

// --- clocks ------------------------------------------------------------------------------------

/** Minutes since local midnight of an instant in a timezone. */
export function localMinutes(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

/** Offset of a timezone from UTC at an instant (ms, local minus UTC). */
function tzOffsetMs(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return wall - Math.floor(at / 1000) * 1000
}

/**
 * The instants (epoch ms) at which the local day and the local month of `at` began in a timezone.
 * Both start at local midnight, so the day always lies inside the month: a total over the day can
 * never exceed the total over the month.
 */
export function periodStarts(
  at: number,
  timezone: string,
): { dayStart: number; monthStart: number } {
  const [y, m, d] = localDay(at, timezone).split('-').map(Number) as [number, number, number]
  const midnight = (day: number): number => {
    const wall = Date.UTC(y, m - 1, day)
    // the offset at midnight itself (a DST change moves it by an hour at most: settle in two steps)
    const first = wall - tzOffsetMs(wall, timezone)
    return wall - tzOffsetMs(first, timezone)
  }
  return { dayStart: midnight(d), monthStart: midnight(1) }
}

/** The calendar day (`YYYY-MM-DD`) of an instant in a timezone. */
export function localDay(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at))
}

const minutesOf = (clock: string): number => {
  const m = HHMM.exec(clock)
  return m === null ? 0 : Number(m[1]) * 60 + Number(m[2])
}

/** Whether `at` is inside the active hours (`from` inclusive, `to` exclusive; equal = always). */
export function inActiveHours(
  at: number,
  c: Pick<HeartbeatConfig, 'activeFrom' | 'activeTo'> & { timezone: string },
): boolean {
  const from = minutesOf(c.activeFrom)
  const to = minutesOf(c.activeTo)
  if (from === to) return true
  const now = localMinutes(at, c.timezone)
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** The cron expression of a daily `HH:MM`. */
export function dailyCron(time: string): string {
  const m = HHMM.exec(time)
  return `${Number(m?.[2] ?? 0)} ${Number(m?.[1] ?? 0)} * * *`
}

// --- the checklist -----------------------------------------------------------------------------

/** Where the checklist lives: the agent's own memory (`/memories/agents/<id>/HEARTBEAT.md`). */
export const CHECKLIST_FILE = 'HEARTBEAT.md'
export const checklistPath = (agentId: string): string =>
  `${agentMemory(agentId)}/${CHECKLIST_FILE}`

/**
 * The checklist's own content: headings, comments, rules and bare list markers do not count. An
 * empty checklist means nothing to check, so the beat is skipped without a model call.
 */
export function checklistContent(text: string | null | undefined): string {
  if (text === null || text === undefined) return ''
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !/^[-*_=\s]{3,}$/.test(l))
    .filter((l) => !/^([-*+]|\d+[.)])(\s*\[[ xX]?\])?$/.test(l))
    .join('\n')
}

export const checklistIsEmpty = (text: string | null | undefined): boolean =>
  checklistContent(text) === ''

/** What the file holds when a person turns the heartbeat on from the web. */
export const CHECKLIST_TEMPLATE = [
  '# Heartbeat checklist',
  '',
  '<!-- One item per line. Leave this file with only headings or comments and the heartbeat does',
  '     not run (no model call). The server already checks stuck, failed and waiting work, open',
  '     decisions, failing programs and routines, connectors that need sign-in and the budget. -->',
  '',
].join('\n')

// --- beats -------------------------------------------------------------------------------------

export const BEAT_STATUSES = ['running', 'ok', 'attention', 'skipped', 'failed'] as const
export type BeatStatus = (typeof BEAT_STATUSES)[number]

/** One thing a beat found, as the model reports it. */
export interface BeatItem {
  kind: string
  title: string
  detail: string
  /** App paths or library paths as evidence (`/decisions`, `/tasks/<id>`, `/library/...`). */
  links: string[]
  urgent: boolean
  /** Stable identity of the finding: the same one is not reported twice within the window. */
  fingerprint: string
}

export interface BeatRecord {
  /** The routine slot (a recovered fire is the same beat). */
  id: string
  at: number
  endedAt: number | null
  status: BeatStatus
  /** Why it was skipped or failed. */
  reason: string | null
  /** Beats of the same skipped reason in a row, collapsed into one record. */
  count: number
  /** What it reported (attention only): the new, not yet reported items. */
  items: BeatItem[]
  /** Items it found that were already reported inside the window. */
  duplicates: number
}

export const MAX_BEATS = 50
/** The same finding is not reported again within this long. */
export const DEDUPE_MS = 24 * 3_600_000
/** A program suggestion is not made again within this long. */
export const SUGGESTION_DEDUPE_MS = 14 * 24 * 3_600_000

export interface HeartbeatState {
  /** Fingerprint to the instant it was last reported. */
  fingerprints: Record<string, number>
  /** Newest first. */
  beats: BeatRecord[]
}

export const EMPTY_HEARTBEAT_STATE: HeartbeatState = { fingerprints: {}, beats: [] }

/** A stable identity from what a finding is about, when the model did not carry one over. */
export function fingerprintOf(item: Pick<BeatItem, 'kind' | 'title' | 'links'>): string {
  const title = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return `${item.kind}:${title}:${[...item.links].sort().join(',')}`.slice(0, 200)
}

const windowOfItem = (item: Pick<BeatItem, 'kind'>): number =>
  item.kind === 'program.suggestion' ? SUGGESTION_DEDUPE_MS : DEDUPE_MS

/** Items not reported inside `windowMs` (the rest are duplicates); a repeat inside one result counts once. */
export function splitNew(
  items: readonly BeatItem[],
  reported: Readonly<Record<string, number>>,
  now: number,
  windowOf: (item: BeatItem) => number = windowOfItem,
): { fresh: BeatItem[]; duplicates: number } {
  const fresh: BeatItem[] = []
  const seen = new Set<string>()
  let duplicates = 0
  for (const item of items) {
    const at = reported[item.fingerprint]
    if (seen.has(item.fingerprint) || (at !== undefined && now - at < windowOf(item))) duplicates++
    else fresh.push(item)
    seen.add(item.fingerprint)
  }
  return { fresh, duplicates }
}

/** Forget fingerprints older than the longest window. */
export function pruneFingerprints(
  reported: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(reported).filter(([, at]) => now - at < SUGGESTION_DEDUPE_MS),
  )
}

/** Add a beat to the history; identical consecutive skips collapse into one record. */
export function pushBeat(beats: readonly BeatRecord[], beat: BeatRecord): BeatRecord[] {
  const [last, ...rest] = beats
  if (
    last !== undefined &&
    beat.status === 'skipped' &&
    last.status === 'skipped' &&
    last.reason === beat.reason
  ) {
    return [{ ...last, at: beat.at, endedAt: beat.at, count: last.count + 1 }, ...rest].slice(
      0,
      MAX_BEATS,
    )
  }
  return [beat, ...beats].slice(0, MAX_BEATS)
}

// --- observations ------------------------------------------------------------------------------

export interface Finding {
  fingerprint: string
  kind: string
  urgent: boolean
  title: string
  detail: string
  links: string[]
}

/** Running with no activity for this long = stuck. */
export const STUCK_MS = 2 * 3_600_000
/** Waiting for a person (approval, question) this long = long-waiting. */
export const WAITING_MS = 6 * 3_600_000
/** An open decision this old is a reminder. */
export const DECISION_OLD_MS = 24 * 3_600_000
/** Failed tasks are reported for this long after they ended. */
export const FAILED_WINDOW_MS = 24 * 3_600_000
/** Budget share used that raises a finding / an urgent one. */
export const BUDGET_NEAR = 0.8
export const BUDGET_URGENT = 0.95
/** Program suggestions: at least this many similar requests in this window. */
export const SUGGEST_MIN_REQUESTS = 3
export const SUGGEST_WINDOW_MS = 14 * 24 * 3_600_000

export interface ProgramObservation {
  program: Pick<Program, 'id' | 'name' | 'status' | 'agentId'>
  /** The schedule trigger: null for a manual program. */
  trigger: { status: Routine['status']; pausedReason: Routine['pausedReason'] } | null
  /** Newest first. */
  runs: Array<Pick<Task, 'id' | 'status' | 'endedAt' | 'summary'> & { costUsd?: number }>
}

export interface ObserveInput {
  now: number
  tasks: readonly Task[]
  decisions: readonly Pick<Decision, 'id' | 'title' | 'kind' | 'createdAt' | 'status'>[]
  /** Sessions parked on an open decision (they show `running` but wait for the client). */
  waitingSessions?: ReadonlySet<string>
  programs: readonly ProgramObservation[]
  /** Routines that are not a program's schedule. */
  routines: readonly Pick<
    Routine,
    'id' | 'name' | 'status' | 'pausedReason' | 'failures' | 'maxFailures' | 'lastStatus'
  >[]
  connections: ReadonlyArray<{ id: string; label: string; status: string; statusMessage?: string }>
  budget: { spentUsd: number; limitUsd: number | null } | null
  /** The requests of the client (DM messages and task titles), for program suggestions. */
  requests: readonly RequestText[]
  /** Names and briefs of programs and open proposals: a suggestion that matches one is not made. */
  existing: readonly string[]
}

const ago = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000)
  if (h >= 48) return `${Math.floor(h / 24)} days`
  if (h >= 1) return `${h} h`
  return `${Math.max(1, Math.floor(ms / 60_000))} min`
}

const f = (
  kind: string,
  key: string,
  title: string,
  detail: string,
  links: string[],
  urgent = false,
): Finding => ({ fingerprint: `${kind}:${key}`, kind, urgent, title, detail, links })

/** The deterministic observations of the heartbeat. Pure: the same input, the same findings. */
export function observe(input: ObserveInput): Finding[] {
  const out: Finding[] = []
  const { now } = input

  const parked = input.waitingSessions ?? new Set<string>()
  for (const t of input.tasks) {
    // a run parked on an open decision is `running` in the index, but it is not stuck: it waits
    // for the client (and `decision.open` below reports the decision once it is old)
    const onDecision = t.status === 'running' && parked.has(t.sessionId)
    if (onDecision) {
      if (now - t.lastActivityAt >= WAITING_MS) {
        out.push(
          f(
            'task.waiting',
            t.id,
            `Waiting for you: ${t.title}`,
            `Parked on a decision in the Decision Center for ${ago(now - t.lastActivityAt)}.`,
            [`/tasks/${t.id}`, '/decisions'],
          ),
        )
      }
    } else if (t.status === 'running' && now - t.lastActivityAt >= STUCK_MS) {
      out.push(
        f(
          'task.stuck',
          t.id,
          `Task looks stuck: ${t.title}`,
          `Running with no activity for ${ago(now - t.lastActivityAt)}.`,
          [`/tasks/${t.id}`],
        ),
      )
    } else if (t.status === 'needs_action' && now - t.lastActivityAt >= WAITING_MS) {
      out.push(
        f(
          'task.waiting',
          t.id,
          `Waiting for you: ${t.title}`,
          `Needs an ${t.pendingKind === 'question' ? 'answer' : 'approval'} for ${ago(now - t.lastActivityAt)}.`,
          [`/tasks/${t.id}`],
        ),
      )
    } else if (
      (t.status === 'failed' || t.status === 'interrupted' || t.status === 'timed_out') &&
      t.endedAt !== null &&
      now - t.endedAt < FAILED_WINDOW_MS &&
      // a failed program run shows up under its program (below)
      parseProgramSession(t.sessionId) === undefined
    ) {
      out.push(
        f('task.failed', t.id, `Task ${t.status}: ${t.title}`, t.summary ?? 'No summary.', [
          `/tasks/${t.id}`,
        ]),
      )
    }
  }

  for (const d of input.decisions) {
    if (d.status === 'open' && now - d.createdAt >= DECISION_OLD_MS) {
      out.push(
        f(
          'decision.open',
          d.id,
          `Decision waiting ${ago(now - d.createdAt)}: ${d.title}`,
          `An open ${d.kind} the client has not answered.`,
          ['/decisions'],
        ),
      )
    }
  }

  for (const p of input.programs) {
    const link = '/programs'
    if (p.trigger?.status === 'paused' && p.trigger.pausedReason === 'max-failures') {
      out.push(
        f(
          'program.paused',
          p.program.id,
          `Program paused itself after repeated failures: ${p.program.name}`,
          'Its schedule stopped. Look at the last runs, fix the cause, then resume it.',
          [link],
          true,
        ),
      )
      continue
    }
    const last = p.runs[0]
    if (
      last !== undefined &&
      (last.status === 'failed' || last.status === 'interrupted') &&
      last.endedAt !== null &&
      now - last.endedAt < FAILED_WINDOW_MS
    ) {
      out.push(
        f(
          'program.failing',
          `${p.program.id}:${last.id}`,
          `Program run failed: ${p.program.name}`,
          // what the run really spent, from the ledger: a "budget used up" stop is a reservation
          // that did not fit, not money burnt (a model must not say otherwise)
          `${last.summary ?? 'No summary.'}${last.costUsd === undefined ? '' : ` (This run actually spent ${usd(last.costUsd)}.)`}`,
          [link, `/tasks/${last.id}`],
        ),
      )
    }
  }

  for (const r of input.routines) {
    if (r.status === 'paused' && r.pausedReason === 'max-failures') {
      out.push(
        f(
          'routine.failing',
          r.id,
          `Routine paused after repeated failures: ${r.name}`,
          `Last status: ${r.lastStatus ?? 'unknown'}.`,
          ['/routines'],
          true,
        ),
      )
    } else if (r.status === 'active' && r.failures >= 2) {
      out.push(
        f(
          'routine.failing',
          `${r.id}:${r.failures}`,
          `Routine failing: ${r.name}`,
          `${r.failures} failed runs in a row (it pauses at ${r.maxFailures}).`,
          ['/routines'],
        ),
      )
    }
  }

  for (const c of input.connections) {
    if (c.status === 'needs-auth' || c.status === 'error') {
      out.push(
        f(
          'connector.reauth',
          c.id,
          c.status === 'needs-auth'
            ? `Connector needs sign-in: ${c.label}`
            : `Connector in error: ${c.label}`,
          c.statusMessage ?? 'Open Connectors and reconnect it.',
          ['/connectors'],
        ),
      )
    }
  }

  if (input.budget !== null && input.budget.limitUsd !== null && input.budget.limitUsd > 0) {
    const share = input.budget.spentUsd / input.budget.limitUsd
    if (share >= BUDGET_NEAR) {
      out.push(
        f(
          'budget.near',
          // one finding per band, so crossing 95 % is reported again
          share >= BUDGET_URGENT ? 'urgent' : 'near',
          `Budget ${Math.round(share * 100)}% used`,
          `${usd(input.budget.spentUsd)} of ${usd(input.budget.limitUsd)} this month. Runs stop at the limit.`,
          ['/settings'],
          share >= BUDGET_URGENT,
        ),
      )
    }
  }

  out.push(...suggestPrograms(input))
  return out
}

// --- program suggestions -----------------------------------------------------------------------

export interface RequestText {
  /** Where it came from, for the evidence (`dm`, `task`). */
  source: 'dm' | 'task'
  text: string
  at: number
  /** `/tasks/<id>` for a task. */
  link?: string
}

const STOP = new Set(
  'the a an and or of to for in on at by with from please can you could would i we me my our us it this that these those is are be do does did have has had will shall should about into over under again also just then than so as if not no yes all any some one new more make write get give need want run check list show'.split(
    ' ',
  ),
)

/**
 * The significant words of a request, by stem (a crude one: plural `s` dropped, cut at six letters,
 * so "summarize" and "summary" meet), mapped to the first word seen for that stem.
 */
export function requestWords(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const w of text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue
    const stem = (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w).slice(0, 6)
    if (!out.has(stem)) out.set(stem, w)
  }
  return out
}

export const requestTokens = (text: string): Set<string> => new Set(requestWords(text).keys())

export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** Requests whose words overlap at least this much are the same kind of request. */
export const SIMILAR = 0.5

export interface RequestCluster {
  /** The words most of the requests share. */
  topic: string
  requests: RequestText[]
}

/**
 * Groups requests of the last `windowMs` that are alike (word overlap, greedy: a request joins the
 * first cluster it resembles) and returns the clusters of at least `min` requests. Deterministic.
 */
export function clusterRequests(
  requests: readonly RequestText[],
  now: number,
  { min = SUGGEST_MIN_REQUESTS, windowMs = SUGGEST_WINDOW_MS } = {},
): RequestCluster[] {
  const recent = requests
    .filter((r) => now - r.at < windowMs && r.at <= now)
    .sort((a, b) => a.at - b.at)
  const clusters: Array<{ tokens: Set<string>; requests: RequestText[] }> = []
  for (const r of recent) {
    const tokens = requestTokens(r.text)
    if (tokens.size < 2) continue
    const home = clusters.find((c) => jaccard(c.tokens, tokens) >= SIMILAR)
    if (home === undefined) clusters.push({ tokens, requests: [r] })
    else home.requests.push(r)
  }
  return clusters
    .filter((c) => c.requests.length >= min)
    .map((c) => {
      const counts = new Map<string, { n: number; word: string }>()
      for (const r of c.requests) {
        for (const [stem, word] of requestWords(r.text)) {
          const seen = counts.get(stem)
          counts.set(stem, { n: (seen?.n ?? 0) + 1, word: seen?.word ?? word })
        }
      }
      const topic = [...counts.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([, v]) => v.word)
        .sort()
        .join(' ')
      return { topic, requests: c.requests }
    })
}

function suggestPrograms(input: ObserveInput): Finding[] {
  const existing = input.existing.map(requestTokens)
  return clusterRequests(input.requests, input.now)
    .filter((c) => {
      const topic = requestTokens(c.topic)
      // already a program (or an open proposal) about it: it covers at least half the topic
      return !existing.some((e) => {
        let shared = 0
        for (const t of topic) if (e.has(t)) shared++
        return shared >= 2 && shared / topic.size >= 0.5
      })
    })
    .map((c) => {
      const links = [...new Set(c.requests.flatMap((r) => (r.link === undefined ? [] : [r.link])))]
      const examples = c.requests
        .slice(-5)
        .map((r) => `- ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`)
        .join('\n')
      return {
        fingerprint: `program.suggestion:${c.topic}`,
        kind: 'program.suggestion',
        urgent: false,
        title: `The client asked for the same thing ${c.requests.length} times: ${c.topic}`,
        detail: `Examples:\n${examples}\nIf a standing program would do it, call propose_plan once (least authority, a schedule that fits, report \`digest\`). Never create anything yourself.`,
        links,
      }
    })
}

const usd = (n: number): string => `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`

// --- the model's view --------------------------------------------------------------------------

/** What `team_status` returns: compact, newest findings first, capped. */
export interface SpendNow {
  /**
   * The workspace budget this month: the limit comes from the ledger, the spend from the call log
   * (the same source as `todayUsd`, over the local month); null when no budget is tracked.
   */
  month: { spentUsd: number; limitUsd: number | null } | null
  /** Model spend since local midnight of the team timezone (the model call log); never above the month. */
  todayUsd: number
}

/** The spend lines of `team_status`: real numbers, so no beat has to guess what was burnt. */
export function spendLines(spend: SpendNow): string[] {
  const month =
    spend.month === null
      ? 'no monthly budget is tracked'
      : `this month ${usd(spend.month.spentUsd)}${spend.month.limitUsd === null ? '' : ` of ${usd(spend.month.limitUsd)}`}`
  return [
    `Spend (from the model call log, not an estimate): ${month}; today ${usd(spend.todayUsd)}.`,
    'A "budget used up" stop of a run means one model call could not be reserved against its limit; it says nothing about money spent. Quote only these numbers and the cost shown for a run.',
  ]
}

/** The board counted by the server: the one place where task counts come from (the model never restates them). */
export function boardLine(tasks: ReadonlyArray<Pick<Task, 'status' | 'report'>>): string {
  const n: Record<RunBucket | 'queued', number> = {
    done: 0,
    failed: 0,
    waiting: 0,
    running: 0,
    queued: 0,
  }
  for (const t of tasks) {
    if (t.status === 'queued') n.queued++
    else n[runBucket(t)]++
  }
  return `Task board (counted by the server, exact): ${tasks.length} task(s): ${n.done} done, ${n.failed} failed, ${n.waiting} waiting for the client, ${n.running} running, ${n.queued} queued. Never restate or recount these in an item: the daily digest prints them. Report only the individual tasks that need attention.`
}

export function statusText(
  findings: readonly Finding[],
  now: number,
  spend?: SpendNow,
  board?: string,
): string {
  const spendText = [board, ...(spend === undefined ? [] : spendLines(spend))]
    .filter((x): x is string => x !== undefined)
    .map((x, i) => (i === 0 ? `\n\n${x}` : `\n${x}`))
    .join('')
  if (findings.length === 0) {
    return `Team status at ${new Date(now).toISOString()}: nothing new to report. Everything the server watches is fine or already reported.${spendText}`
  }
  const lines = findings.slice(0, 30).map((x, i) => {
    const links = x.links.length === 0 ? '' : `\n   links: ${x.links.join(', ')}`
    return `${i + 1}. [${x.kind}]${x.urgent ? ' URGENT' : ''} ${x.title}\n   ${x.detail.replace(/\n/g, '\n   ')}\n   fingerprint: ${x.fingerprint}${links}`
  })
  const more = findings.length > 30 ? `\n(${findings.length - 30} more not shown)` : ''
  return `Team status at ${new Date(now).toISOString()}: ${findings.length} finding(s) not reported yet.\n\n${lines.join('\n')}${more}${spendText}`
}

/** The turn that starts a beat. The checklist is the person's; the findings come from the tool. */
export function beatPrompt(input: {
  now: number
  timezone: string
  checklist: string
  agentName: string
}): string {
  return [
    `Heartbeat of ${input.agentName}: ${new Date(input.now).toISOString()} (${input.timezone}).`,
    '',
    'You are the quiet monitor of this team. Nobody is watching this turn and you are read-only:',
    'you may read the library, call team_status, list_tasks and propose_plan, and use the tools of',
    'connected services that only look things up (read-only); nothing else.',
    'The client does not want noise: report only what needs their attention.',
    '',
    '## How to run',
    '1. Call team_status. It lists what the server found, with a fingerprint for each finding.',
    '2. Work through the checklist below (read the library files it names; for a line that names a',
    '   connected service, call its read-only tools).',
    '3. Decide what deserves the client attention. A finding that is just information, or that you',
    '   cannot act on, still goes in the result as an item; routine and healthy things do not.',
    '   About money: say only what team_status states as spend, or the cost of a run. Never infer',
    '   that a budget was burnt from a stop message. About the board: never write counts of tasks',
    '   (done, failed, waiting) in an item; team_status states them and the digest prints them.',
    '4. Mark an item urgent only when waiting for the daily digest would cost something (a program',
    '   paused itself, a limit is about to stop all work, data may be lost). Urgent items reach',
    '   the client bell at once; you never wait for an answer, so do not ask questions.',
    '5. A finding of kind program.suggestion may become one propose_plan call (a standing program',
    '   with the least authority that works). Never more than one proposal per beat, and never',
    '   anything for a finding of another kind.',
    '6. End with the final_answer tool: status `ok` (nothing needs attention, items empty) or',
    '   `attention` with items { kind, title, detail, links, urgent, fingerprint }. Keep the',
    '   fingerprint of a team_status finding unchanged. Be brief: one line of detail each.',
    '',
    '## Checklist',
    input.checklist.trim(),
  ].join('\n')
}

// --- tools of the run profile ------------------------------------------------------------------

export const TEAM_STATUS_TOOL = 'team_status'

/**
 * What a heartbeat session may call (closed world, nobody to ask): the base tools, the findings,
 * the two ways to reach the client, and reading the library. No writes: it does not feed memory.
 */
export const HEARTBEAT_ALLOWED = [
  'tool_search',
  'load_skill',
  'read_skill_file',
  'search_skills',
  TEAM_STATUS_TOOL,
  // the board (phase C): read only
  'list_tasks',
  'propose_plan',
  'Read(/library/**)',
] as const

export function heartbeatRefusal(toolName: string): string {
  return (
    `Not available in a heartbeat: ${toolName}. A heartbeat is read-only: it reads the library and ` +
    'the read-only tools of connected services, calls team_status, and asks the client through ' +
    'propose_plan. Report what you found as an item of the final answer instead.'
  )
}

// --- the daily digest --------------------------------------------------------------------------

export interface DigestEntry {
  at: number
  agentId: string
  item: BeatItem
}

export interface DigestState {
  lastSentAt: number | null
  /** The local day of the last digest (a recovered fire does not send twice). */
  lastSentOn: string | null
  buffer: DigestEntry[]
}

export const EMPTY_DIGEST_STATE: DigestState = { lastSentAt: null, lastSentOn: null, buffer: [] }
export const MAX_DIGEST_BUFFER = 200

export interface DigestInput {
  since: number
  until: number
  /** Program runs of the window. */
  runs: ReadonlyArray<{
    programName: string
    report: 'digest' | 'task' | 'silent'
    task: Pick<Task, 'id' | 'status' | 'summary' | 'report'>
  }>
  decisions: ReadonlyArray<Pick<Decision, 'id' | 'title' | 'kind' | 'createdAt'>>
  /** Tasks waiting for a person or for review. */
  waiting: ReadonlyArray<Pick<Task, 'id' | 'title'> & { why: string }>
  items: readonly DigestEntry[]
  costUsd: number
  heartbeatCostUsd: number
}

export interface Digest {
  text: string
  /** The same content as items (the Briefing page and "Discuss in chat"). */
  items: BriefingItem[]
  /** Nothing ran, nothing waits, nothing was found and nothing was spent. */
  empty: boolean
}

const oneLine = (s: string, max = 200): string => {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const MAX_FAILED_LISTED = 10

type RunBucket = 'done' | 'failed' | 'waiting' | 'running'

/** Where a run counts in the digest header: what it reports, else what its session says. */
function runBucket(task: Pick<Task, 'status' | 'report'>): RunBucket {
  if (task.report?.status === 'failed') return 'failed'
  if (task.report?.status === 'needs_decision') return 'waiting'
  switch (task.status) {
    case 'done':
      return 'done'
    case 'needs_action':
      return 'waiting'
    case 'queued':
    case 'running':
      return 'running'
    default:
      return 'failed'
  }
}

/** "19 runs: 14 done, 3 failed, 2 waiting for you": every run of the window, counted from the board. */
function runCounts(tasks: ReadonlyArray<Pick<Task, 'status' | 'report'>>): string {
  const n: Record<RunBucket, number> = { done: 0, failed: 0, waiting: 0, running: 0 }
  for (const t of tasks) n[runBucket(t)]++
  const parts = [
    n.done > 0 ? `${n.done} done` : '',
    n.failed > 0 ? `${n.failed} failed` : '',
    n.waiting > 0 ? `${n.waiting} waiting for you` : '',
    n.running > 0 ? `${n.running} still running` : '',
  ].filter(Boolean)
  return `${tasks.length} run${tasks.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}

/** The digest message (markdown), built from data. */
export function buildDigest(input: DigestInput): Digest {
  const shown = input.runs.filter((r) => r.report !== 'silent')
  const detailed = shown.filter((r) => r.report === 'digest')
  // a run that failed is never hidden behind "on the board", whatever its program reports
  const failedOther = shown.filter((r) => r.report !== 'digest' && runBucket(r.task) === 'failed')
  const onBoard = shown.length - detailed.length - failedOther.length
  const empty =
    shown.length === 0 &&
    input.decisions.length === 0 &&
    input.waiting.length === 0 &&
    input.items.length === 0 &&
    input.costUsd === 0
  const out: string[] = ['**Daily digest**', '']
  const items: BriefingItem[] = []

  out.push('### What ran')
  if (shown.length === 0) out.push('No program runs.')
  else out.push(runCounts(shown.map((r) => r.task)))
  for (const r of detailed) {
    const rep = r.task.report
    const status = rep?.status ?? r.task.status
    out.push(`- **${r.programName}**: ${status}${rep === null ? '' : ` — ${oneLine(rep.summary)}`}`)
    items.push({
      kind: 'run',
      title: r.programName,
      detail: `${status}${rep === null ? '' : ` — ${oneLine(rep.summary)}`}${(rep?.outputs.length ?? 0) === 0 ? '' : `. Outputs: ${rep?.outputs.slice(0, 5).join(', ')}`}`,
      link: `/tasks/${r.task.id}`,
    })
    for (const o of rep?.outputs.slice(0, 5) ?? []) out.push(`  - ${o}`)
  }
  for (const r of failedOther.slice(0, MAX_FAILED_LISTED)) {
    const rep = r.task.report
    out.push(
      `- **${r.programName}**: failed — ${oneLine(rep?.summary ?? r.task.summary ?? 'no summary')} (/tasks/${r.task.id})`,
    )
    items.push({
      kind: 'run',
      title: r.programName,
      detail: `failed — ${oneLine(rep?.summary ?? r.task.summary ?? 'no summary')}`,
      link: `/tasks/${r.task.id}`,
    })
  }
  if (failedOther.length > MAX_FAILED_LISTED) {
    out.push(
      `- ${failedOther.length - MAX_FAILED_LISTED} more failed run(s) are on the board (/tasks).`,
    )
  }
  if (onBoard > 0) out.push(`- ${onBoard} more run(s) are on the board (/tasks).`)

  out.push('', '### Waiting for you')
  if (input.decisions.length === 0 && input.waiting.length === 0) out.push('Nothing.')
  for (const d of input.decisions) {
    out.push(`- Decision (${d.kind}): ${oneLine(d.title)} (/decisions)`)
    items.push({
      kind: 'decision',
      title: oneLine(d.title, 120),
      detail: `Open ${d.kind} decision`,
      link: '/decisions',
    })
  }
  for (const w of input.waiting) {
    out.push(`- ${oneLine(w.title)} — ${w.why} (/tasks/${w.id})`)
    items.push({
      kind: 'waiting',
      title: oneLine(w.title, 120),
      detail: w.why,
      link: `/tasks/${w.id}`,
    })
  }

  if (input.items.length > 0) {
    out.push('', '### Noticed by the heartbeat')
    for (const e of input.items) {
      const links = e.item.links.length === 0 ? '' : ` (${e.item.links.join(', ')})`
      out.push(`- **${oneLine(e.item.title, 120)}**: ${oneLine(e.item.detail)}${links}`)
      items.push({
        kind: 'noticed',
        title: oneLine(e.item.title, 120),
        detail: oneLine(e.item.detail),
        link: e.item.links[0] ?? null,
      })
    }
  }

  out.push('', '### Cost')
  out.push(
    `${usd(input.costUsd)} in the last ${hoursLabel(input.until - input.since)}${
      input.heartbeatCostUsd > 0 ? `, of which the heartbeat ${usd(input.heartbeatCostUsd)}` : ''
    }.`,
  )
  return { text: out.join('\n'), items, empty }
}

const hoursLabel = (ms: number): string => `${Math.max(1, Math.round(ms / 3_600_000))} h`

/** The one short message of an urgent finding. */
export function urgentText(items: readonly BeatItem[]): string {
  const lines = items
    .slice(0, 5)
    .map(
      (i) =>
        `- **${oneLine(i.title, 120)}**: ${oneLine(i.detail, 160)}${i.links[0] === undefined ? '' : ` (${i.links[0]})`}`,
    )
  return `**Needs your attention now**\n${lines.join('\n')}${items.length > 5 ? `\n- and ${items.length - 5} more (see the digest)` : ''}`
}

// --- system routines ---------------------------------------------------------------------------

/**
 * The heartbeat and the digest ride on routine rows (claim, recovery and restart safety come with
 * them). Such a routine carries a `sys:` key in `routines.program_id`: it is not listed as a
 * routine, and the routine service hands its fire to the heartbeat runner, not to a prompt.
 */
export const heartbeatKey = (agentId: string): string => `sys:heartbeat:${agentId}`
export const DIGEST_KEY = 'sys:digest'
/** A reminder created from a chat (P41 L6): its schedule is a routine, its fire posts a fixed text. */
export const reminderKey = (reminderId: string): string => `sys:reminder:${reminderId}`

export type SystemRoutine =
  | { kind: 'heartbeat'; agentId: string }
  | { kind: 'digest' }
  | { kind: 'reminder'; id: string }

export function parseSystemKey(key: string | null | undefined): SystemRoutine | undefined {
  if (key === null || key === undefined || !key.startsWith('sys:')) return undefined
  if (key === DIGEST_KEY) return { kind: 'digest' }
  const r = /^sys:reminder:(.+)$/.exec(key)
  if (r !== null) return { kind: 'reminder', id: r[1] as string }
  const m = /^sys:heartbeat:(.+)$/.exec(key)
  return m === null ? undefined : { kind: 'heartbeat', agentId: m[1] as string }
}

// --- the result of a beat ----------------------------------------------------------------------

export const MAX_BEAT_ITEMS = 20

/** An item that only restates task counts ("Task board: 6 tasks done, none failed"). */
export function restatesBoardCounts(kind: string, title: string, detail: string): boolean {
  if (/^(task\.)?board(\.summary)?$/i.test(kind)) return true
  const text = `${title} ${detail}`
  return (
    /\btask board\b/i.test(title) ||
    /\b\d+\s+(tasks?|runs?)\b[^.]{0,40}\b(done|completed|failed|waiting|running|queued)\b/i.test(
      text,
    ) ||
    /\bnone\s+(failed|waiting)\b/i.test(text)
  )
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** The validated final answer of a beat (`BEAT_SCHEMA`) as items; undefined when it is not one. */
export function parseBeatResult(value: unknown): { items: BeatItem[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.status !== 'ok' && v.status !== 'attention') return undefined
  const raw = Array.isArray(v.items) ? v.items : []
  const items: BeatItem[] = []
  for (const entry of raw.slice(0, MAX_BEAT_ITEMS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const title = str(e.title, 200).trim()
    if (title === '') continue
    const kind = str(e.kind, 60).trim() || 'note'
    // board counts are the server's: a model summary of them can only contradict the board
    if (restatesBoardCounts(kind, title, str(e.detail, 1000))) continue
    const links = Array.isArray(e.links)
      ? e.links
          .filter((l): l is string => typeof l === 'string')
          .map((l) => l.slice(0, 300))
          .slice(0, 8)
      : []
    const base = { kind, title, links }
    const fingerprint = str(e.fingerprint, 200).trim() || fingerprintOf(base)
    items.push({ ...base, detail: str(e.detail, 1000), urgent: e.urgent === true, fingerprint })
  }
  return { items }
}
