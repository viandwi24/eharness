/**
 * Heartbeat and daily digest use cases (docs/plans/P40-team-autonomous-operations.md, D9 and D10).
 *
 * The heartbeat and the digest are woken by routine rows with a `sys:` key (`domain/heartbeat.ts`):
 * the routine service claims the slot and hands it to `infra/eh/heartbeat-service.ts`, which asks
 * this module what to do (`beginBeat`), runs the beat's session, and gets the result back through
 * the `turn.end` hook (`finishBeat`). Everything that decides (active hours, empty checklist,
 * findings, deduplication, the digest text) is here and deterministic; the model only reads the
 * findings and writes the proposal of a program, when it sees a pattern.
 */

import { conflict } from '../domain/errors.ts'
import {
  type BeatItem,
  type BeatRecord,
  beatPrompt,
  boardLine,
  buildDigest,
  CHECKLIST_TEMPLATE,
  checkDigestFields,
  checkHeartbeatFields,
  checklistIsEmpty,
  checklistPath,
  DIGEST_KEY,
  type DigestConfig,
  type DigestState,
  dailyCron,
  defaultHeartbeat,
  type Finding,
  type HeartbeatConfig,
  type HeartbeatState,
  heartbeatKey,
  inActiveHours,
  localDay,
  MAX_DIGEST_BUFFER,
  observe,
  parseBeatResult,
  periodStarts,
  pruneFingerprints,
  pushBeat,
  type RequestText,
  splitNew,
  statusText,
} from '../domain/heartbeat.ts'
import { parseProgramSession } from '../domain/programs.ts'
import type { RoutineSpec } from '../domain/routines.ts'
import { boardColumn, type Task } from '../domain/tasks.ts'
import { getAgent } from './agents.ts'
import { postAlerts, postBriefing } from './briefings.ts'
import type { Deps } from './ports.ts'
import { threadSessionsOf } from './threads.ts'
import { sessionsWithOpenDecision } from './work-queue.ts'

const HOUR = 3_600_000
/** A beat recorded as running this long ago, with no turn in sight, is a dead one. */
const STALE_BEAT_MS = 10 * 60_000
/** The digest looks this far back when there was none before. */
const FIRST_DIGEST_WINDOW_MS = 24 * HOUR

const lead = (deps: Deps) => deps.agents.list().find((a) => a.role === 'lead')

// --- configuration -----------------------------------------------------------------------------

export interface HeartbeatView {
  agentId: string
  config: HeartbeatConfig
  /** The timezone of the active hours in effect (the agent's own, else the team timezone). */
  effectiveTimezone: string
  /** False while nothing was ever set: the config is the default of the agent's role. */
  stored: boolean
  checklist: { path: string; exists: boolean; empty: boolean }
  /** The routine that wakes it. */
  trigger: {
    status: 'active' | 'paused'
    nextFireAt: number | null
    lastFireAt: number | null
  } | null
  /** Newest first. */
  beats: BeatRecord[]
  /** `timezone` as stored (null = the team timezone), `effectiveTimezone` as used. */
  digest: DigestConfig & { effectiveTimezone: string; buffered: number; lastSentAt: number | null }
}

export const effectiveConfig = (deps: Deps, agent: { id: string; role: string }): HeartbeatConfig =>
  deps.heartbeat.store.config(agent.id) ?? defaultHeartbeat(agent)

/** The timezone in effect for an agent's active hours: its own, else the team's. */
export const heartbeatTimezone = (deps: Deps, config: HeartbeatConfig): string =>
  config.timezone ?? deps.settings.get().timezone

export async function getHeartbeat(deps: Deps, idOrSlug: string): Promise<HeartbeatView> {
  const agent = getAgent(deps, idOrSlug)
  const file = await deps.library.read(checklistPath(agent.id))
  const routine = deps.routines.getByProgram(heartbeatKey(agent.id))
  return {
    agentId: agent.id,
    config: effectiveConfig(deps, agent),
    effectiveTimezone: heartbeatTimezone(deps, effectiveConfig(deps, agent)),
    stored: deps.heartbeat.store.config(agent.id) !== undefined,
    checklist: {
      path: checklistPath(agent.id),
      exists: file !== undefined,
      empty: checklistIsEmpty(file?.text),
    },
    trigger:
      routine === undefined
        ? null
        : {
            status: routine.status,
            nextFireAt: routine.nextFireAt,
            lastFireAt: routine.lastFireAt,
          },
    beats: deps.heartbeat.store.state(agent.id).beats,
    digest: digestView(deps),
  }
}

export function digestView(deps: Deps): HeartbeatView['digest'] {
  const config = deps.heartbeat.store.digestConfig()
  const state = deps.heartbeat.store.digest()
  return {
    ...config,
    effectiveTimezone: digestTimezone(deps, config),
    buffered: state.buffer.length,
    lastSentAt: state.lastSentAt,
  }
}

function digestTimezone(deps: Deps, config: DigestConfig): string {
  return config.timezone ?? deps.settings.get().timezone
}

const changed = (deps: Deps, agentId: string | null, change: string): void =>
  deps.events.append({ type: 'heartbeat-changed', agentId, payload: { change } })

export async function setHeartbeat(
  deps: Deps,
  idOrSlug: string,
  patch: Partial<HeartbeatConfig> & { createChecklist?: boolean | undefined },
): Promise<HeartbeatView> {
  const agent = getAgent(deps, idOrSlug)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const { createChecklist, ...fields } = patch
  checkHeartbeatFields(fields)
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<HeartbeatConfig>
  const next: HeartbeatConfig = { ...effectiveConfig(deps, agent), ...clean }
  deps.heartbeat.store.setConfig(agent.id, next, deps.clock.now())
  // turning it on gives the person a file to write the checklist in
  if (
    createChecklist === true &&
    (await deps.library.read(checklistPath(agent.id))) === undefined
  ) {
    await deps.library.writeText(checklistPath(agent.id), CHECKLIST_TEMPLATE, null)
  }
  syncHeartbeatRoutine(deps, agent.id)
  changed(deps, agent.id, 'config')
  return getHeartbeat(deps, agent.id)
}

export function setDigest(deps: Deps, patch: Partial<DigestConfig>): DigestConfig {
  checkDigestFields(patch)
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<DigestConfig>
  const next = { ...deps.heartbeat.store.digestConfig(), ...clean }
  deps.heartbeat.store.setDigestConfig(next, deps.clock.now())
  syncDigestRoutine(deps)
  changed(deps, null, 'digest')
  return next
}

// --- the routines that wake them ---------------------------------------------------------------

/**
 * Make a system routine (the heartbeat's or the digest's) match what is wanted: create it, retime
 * it, pause it, resume it. Straight on the store: these rows are internal (not listed as routines,
 * no `routine-changed` events); `heartbeat-changed` tells the web.
 */
function syncSystemRoutine(
  deps: Deps,
  want: {
    key: string
    agentId: string
    name: string
    prompt: string
    active: boolean
    schedule: RoutineSpec
  },
): void {
  const now = deps.clock.now()
  const existing = deps.routines.getByProgram(want.key)
  const slot = (): number | null => deps.schedule.next(want.schedule, now)
  if (existing === undefined) {
    if (!want.active) return
    deps.schedule.validate(want.schedule)
    deps.routines.insert({
      id: deps.ids.next(),
      agentId: want.agentId,
      name: want.name.slice(0, 120),
      prompt: want.prompt,
      schedule: want.schedule,
      sessionMode: 'task',
      // the runner skips a beat that overlaps; the routine does not look at sessions
      overlap: 'queue',
      catchUpWindowMs: null,
      maxFailures: 100,
      maxFires: null,
      endAt: null,
      nextFireAt: slot(),
      programId: want.key,
      now,
    })
    return
  }
  if (!want.active) {
    if (existing.status === 'active') {
      deps.routines.update(existing.id, { status: 'paused', pausedReason: 'manual' }, now)
    }
    return
  }
  const same = JSON.stringify(existing.schedule) === JSON.stringify(want.schedule)
  if (same && existing.status === 'active') return
  deps.schedule.validate(want.schedule)
  deps.routines.update(
    existing.id,
    {
      schedule: want.schedule,
      status: 'active',
      pausedReason: null,
      failures: 0,
      // a retimed or resumed routine gets its next slot from now: nothing missed fires
      nextFireAt: same && existing.nextFireAt !== null ? existing.nextFireAt : slot(),
    },
    now,
  )
}

/** Make the routine of an agent's heartbeat match its configuration (create, retime, pause, resume). */
export function syncHeartbeatRoutine(deps: Deps, agentId: string): void {
  const agent = getAgent(deps, agentId)
  const config = effectiveConfig(deps, agent)
  syncSystemRoutine(deps, {
    key: heartbeatKey(agent.id),
    agentId: agent.id,
    name: `Heartbeat: ${agent.name}`,
    prompt: `Heartbeat of ${agent.name}`,
    active: config.enabled && agent.archivedAt === null,
    schedule: { kind: 'every', everyMs: config.everyMinutes * 60_000 },
  })
}

/** The daily digest's routine: a cron at the digest time in the digest timezone, on the lead. */
export function syncDigestRoutine(deps: Deps): void {
  const l = lead(deps)
  if (l === undefined) return
  const config = deps.heartbeat.store.digestConfig()
  syncSystemRoutine(deps, {
    key: DIGEST_KEY,
    agentId: l.id,
    name: 'Daily digest',
    prompt: 'Send the daily digest',
    active: config.enabled && l.archivedAt === null,
    schedule: { kind: 'cron', expr: dailyCron(config.time), tz: digestTimezone(deps, config) },
  })
}

/** Boot: every agent with a heartbeat has its routine, and the lead has the digest. */
export function ensureHeartbeats(deps: Deps): void {
  for (const agent of deps.agents.list({ includeArchived: true })) {
    if (
      agent.archivedAt === null ||
      deps.routines.getByProgram(heartbeatKey(agent.id)) !== undefined
    ) {
      syncHeartbeatRoutine(deps, agent.id)
    }
  }
  syncDigestRoutine(deps)
}

// --- observations ------------------------------------------------------------------------------

/** Text of the requests the client made, for the program suggestions. */
async function collectRequests(deps: Deps, now: number): Promise<RequestText[]> {
  const out: RequestText[] = []
  for (const agent of deps.agents.list()) {
    for (const sessionId of threadSessionsOf(deps, agent.id)) {
      const messages = await deps.heartbeat.requests(sessionId, 100)
      for (const m of messages) out.push({ source: 'dm', text: m.text, at: m.at })
    }
  }
  for (const t of deps.tasks.list({ limit: 300 })) {
    // delegations of the lead repeat what the client said in the DM: only what the client made
    const queued = (t as { createdBy?: string | null }).createdBy === 'client'
    if (t.origin === 'user' || queued) {
      out.push({ source: 'task', text: t.title, at: t.startedAt, link: `/tasks/${t.id}` })
    }
  }
  return out.filter((r) => r.at <= now)
}

/** Everything the server watches, as findings (including the ones already reported). */
export async function observeTeam(deps: Deps, now: number): Promise<Finding[]> {
  const tasks = deps.tasks.list({ limit: 300 })
  const programs = deps.programs.list({}).map((program) => {
    const routine = deps.routines.getByProgram(program.id)
    return {
      program,
      trigger:
        routine === undefined
          ? null
          : { status: routine.status, pausedReason: routine.pausedReason },
      runs: deps.tasks.ofProgram(program.id, 3),
    }
  })
  const proposals = deps.decisions.list({ status: 'open', kind: 'proposal', limit: 50 })
  const budget = await deps.heartbeat.budget()
  const connections = (await deps.connectors.connections()).filter((c) => c.enabled)
  return observe({
    now,
    tasks,
    decisions: deps.decisions.list({ status: 'open', limit: 100 }),
    waitingSessions: sessionsWithOpenDecision(deps),
    programs,
    routines: deps.routines.list({}),
    connections: connections.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      ...(c.statusMessage === undefined ? {} : { statusMessage: c.statusMessage }),
    })),
    budget,
    requests: await collectRequests(deps, now),
    existing: [
      ...deps.programs.list({}).flatMap((p) => [p.name, p.brief]),
      ...proposals.flatMap((d) =>
        d.kind === 'proposal' ? [d.payload.program.name, d.payload.program.brief] : [],
      ),
    ],
  })
}

/**
 * What `team_status` tells the model: the findings not reported yet inside their window (so the
 * model reads what is new, and a persisting problem comes back once a day, not every beat).
 */
export async function teamStatus(
  deps: Deps,
  agentId: string,
  now = deps.clock.now(),
): Promise<{ text: string; findings: Finding[] }> {
  const all = await observeTeam(deps, now)
  const state = deps.heartbeat.store.state(agentId)
  const { fresh } = splitNew(all, state.fingerprints, now)
  // a suggestion is made once: remember it as soon as the model has read it
  const suggestions = fresh.filter((f) => f.kind === 'program.suggestion')
  if (suggestions.length > 0) {
    deps.heartbeat.store.updateState(
      agentId,
      (s) => ({
        ...s,
        fingerprints: {
          ...s.fingerprints,
          ...Object.fromEntries(suggestions.map((f) => [f.fingerprint, now])),
        },
      }),
      now,
    )
  }
  // The month is the budget ledger (the same number as Settings > Usage and the budget check; not
  // pruned); today is the call log (the Logs page) inside the team-timezone day, never above the month.
  const { dayStart, monthStart } = periodStarts(now, deps.settings.get().timezone)
  const ledger = await deps.heartbeat.budget()
  const monthSpent =
    ledger?.spentUsd ?? deps.modelCalls.stats({ from: monthStart, to: now }).totals.costUsd
  const todaySpent = deps.modelCalls.stats({ from: dayStart, to: now }).totals.costUsd
  const spend = {
    month: ledger === null ? null : { spentUsd: monthSpent, limitUsd: ledger.limitUsd },
    todayUsd: Math.min(todaySpent, monthSpent),
  }
  const board = boardLine(deps.tasks.list({ limit: 300 }))
  return { text: statusText(fresh, now, spend, board), findings: fresh }
}

// --- a beat ------------------------------------------------------------------------------------

export type BeatPlan = { run: true; prompt: string } | { run: false; reason: string }

/**
 * Decide what a fire of the heartbeat does and record it. `session` is what the runner saw of the
 * rolling session (a turn is running, or a run waits for a decision). A skip costs no model call.
 */
export async function beginBeat(
  deps: Deps,
  agentId: string,
  input: { id: string; at: number; session: { busy: boolean; waiting: boolean } },
): Promise<BeatPlan> {
  const agent = getAgent(deps, agentId)
  const config = effectiveConfig(deps, agent)
  const { at } = input
  const skip = (reason: string): BeatPlan => {
    pushRecord(deps, agent.id, at, {
      id: input.id,
      at,
      endedAt: at,
      status: 'skipped',
      reason,
      count: 1,
      items: [],
      duplicates: 0,
    })
    return { run: false, reason }
  }
  const state = deps.heartbeat.store.state(agent.id)
  // a recovered fire of the same slot is the same beat
  if (state.beats.some((b) => b.id === input.id)) return { run: false, reason: 'duplicate' }
  if (!config.enabled || agent.archivedAt !== null) return skip('the heartbeat is off')
  const timezone = heartbeatTimezone(deps, config)
  if (!inActiveHours(at, { ...config, timezone })) return skip('outside active hours')
  const file = await deps.library.read(checklistPath(agent.id))
  if (checklistIsEmpty(file?.text)) return skip('empty checklist')
  if (input.session.waiting) return skip('the previous beat waits for a decision')
  const last = state.beats.find((b) => b.status === 'running')
  if (input.session.busy || (last !== undefined && at - last.at < STALE_BEAT_MS)) {
    return skip('the previous beat is still running')
  }

  // a beat that never ended (the process died) is closed so the history does not lie
  deps.heartbeat.store.updateState(
    agent.id,
    (s) => ({
      ...s,
      beats: s.beats.map((b) =>
        b.status === 'running'
          ? {
              ...b,
              status: 'failed' as const,
              endedAt: at,
              reason: 'interrupted (the server stopped)',
            }
          : b,
      ),
    }),
    at,
  )
  pushRecord(deps, agent.id, at, {
    id: input.id,
    at,
    endedAt: null,
    status: 'running',
    reason: null,
    count: 1,
    items: [],
    duplicates: 0,
  })
  return {
    run: true,
    prompt: beatPrompt({
      now: at,
      timezone,
      checklist: file?.text ?? '',
      agentName: agent.name,
    }),
  }
}

function pushRecord(deps: Deps, agentId: string, at: number, beat: BeatRecord): void {
  deps.heartbeat.store.updateState(agentId, (s) => ({ ...s, beats: pushBeat(s.beats, beat) }), at)
  changed(deps, agentId, 'beat')
}

export interface BeatEnd {
  agentId: string
  /** The stop reason of the turn. */
  stop: string
  /** The validated final answer, when the turn produced one. */
  output: unknown
  at: number
}

/** The turn of a beat ended: record it, queue what is new for the digest, interrupt for urgent. */
export async function finishBeat(deps: Deps, end: BeatEnd): Promise<BeatRecord | undefined> {
  const { agentId, at } = end
  const parsed = end.stop === 'complete' ? parseBeatResult(end.output) : undefined
  let fresh: BeatItem[] = []
  let duplicates = 0
  let status: BeatRecord['status']
  let reason: string | null = null
  if (parsed === undefined) {
    status = 'failed'
    reason = end.stop === 'complete' ? 'no valid final answer' : `stopped: ${end.stop}`
  } else {
    const state = deps.heartbeat.store.state(agentId)
    const split = splitNew(parsed.items, state.fingerprints, at)
    fresh = split.fresh
    duplicates = split.duplicates
    status = fresh.length > 0 ? 'attention' : 'ok'
  }

  let record: BeatRecord | undefined
  deps.heartbeat.store.updateState(
    agentId,
    (s) => {
      const open = s.beats.find((b) => b.status === 'running')
      record = {
        id: open?.id ?? String(at),
        at: open?.at ?? at,
        endedAt: at,
        status,
        reason,
        count: 1,
        items: fresh,
        duplicates,
      }
      const beats =
        open === undefined
          ? pushBeat(s.beats, record)
          : s.beats.map((b) => (b.id === open.id ? (record as BeatRecord) : b))
      return {
        fingerprints: {
          ...pruneFingerprints(s.fingerprints, at),
          ...Object.fromEntries(fresh.map((i) => [i.fingerprint, at])),
        },
        beats,
      }
    },
    at,
  )

  if (fresh.length > 0) {
    deps.heartbeat.store.updateDigest(
      (d) => ({
        ...d,
        buffer: [...d.buffer, ...fresh.map((item) => ({ at, agentId, item }))].slice(
          -MAX_DIGEST_BUFFER,
        ),
      }),
      at,
    )
    const urgent = fresh.filter((i) => i.urgent)
    if (urgent.length > 0) {
      // urgent findings go to the bell, one alert each: no chat message, no interruption
      postAlerts(deps, { agentId, beatId: record?.id ?? String(at), items: urgent, at })
    }
  }
  changed(deps, agentId, 'beat')
  return record
}

// --- the daily digest --------------------------------------------------------------------------

const waitingOf = (t: Task): string | undefined => {
  if (t.status === 'needs_action') {
    return t.pendingKind === 'question' ? 'waits for your answer' : 'waits for your approval'
  }
  // finished work the client has not accepted yet (the work queue's Review column)
  return boardColumn(t, false) === 'review' ? 'in Review' : undefined
}

export type DigestOutcome = 'sent' | 'empty' | 'duplicate' | 'off'

/**
 * Build and send the digest of the time since the last one. Idempotent per local day (a recovered
 * fire sends nothing twice); a quiet day sends nothing at all.
 */
export async function runDigest(deps: Deps, at = deps.clock.now()): Promise<DigestOutcome> {
  const config = deps.heartbeat.store.digestConfig()
  if (!config.enabled) return 'off'
  const tz = digestTimezone(deps, config)
  const day = localDay(at, tz)
  const state = deps.heartbeat.store.digest()
  if (state.lastSentOn === day) return 'duplicate'

  const since = state.lastSentAt ?? at - FIRST_DIGEST_WINDOW_MS
  const tasks = deps.tasks.list({ limit: 500 })
  const programs = new Map(deps.programs.list({}).map((p) => [p.id, p]))
  // every run that was active in the window counts: also one that started before it and ended in
  // it (a worker task queued yesterday), and the runs of routines, not only of programs
  const activeInWindow = (t: Task): boolean =>
    t.startedAt >= since || (t.endedAt ?? t.lastActivityAt) >= since
  const runs = tasks
    .filter((t) => (t.origin === 'program' || t.origin === 'routine') && activeInWindow(t))
    .map((task) => {
      const program = programs.get(parseProgramSession(task.sessionId)?.programId ?? '')
      return {
        programName: program?.name ?? task.title.replace(/^Program run: /, ''),
        report: program?.report ?? ('task' as const),
        task,
      }
    })
  const waiting = tasks.flatMap((t) => {
    const why = waitingOf(t)
    return why === undefined ? [] : [{ id: t.id, title: t.title, why }]
  })
  const cost = (sessionId?: string): number =>
    deps.modelCalls.stats({
      from: since,
      to: at,
      ...(sessionId === undefined ? {} : { sessionId }),
    }).totals.costUsd
  const digest = buildDigest({
    since,
    until: at,
    runs,
    decisions: deps.decisions.list({ status: 'open', limit: 50 }),
    waiting,
    items: state.buffer.filter((e) => e.at <= at),
    // test runs (rehearsals) are not part of the day's work
    costUsd: Math.max(0, cost() - deps.rehearsals.spentBetween(since, at)),
    heartbeatCostUsd: deps.agents.list().reduce((sum, a) => sum + cost(`heartbeat:${a.id}`), 0),
  })
  // the digest is a page (one briefing per day) plus one bell notification, not a chat message
  if (!digest.empty) postBriefing(deps, { day, body: digest.text, items: digest.items, at })
  deps.heartbeat.store.updateDigest(
    (d): DigestState => ({
      lastSentAt: at,
      lastSentOn: day,
      buffer: d.buffer.filter((e) => e.at > at),
    }),
    at,
  )
  changed(deps, null, 'digest-sent')
  return digest.empty ? 'empty' : 'sent'
}

/** The state a test or the web reads: the buffer of items waiting for the digest. */
export function digestBuffer(deps: Deps): DigestState {
  return deps.heartbeat.store.digest()
}

export type { HeartbeatState }

/** Close a beat that is still `running` and will not end by itself (it never started). */
export function abandonBeat(deps: Deps, agentId: string, reason: string, at: number): void {
  deps.heartbeat.store.updateState(
    agentId,
    (s) => ({
      ...s,
      beats: s.beats.map((b) =>
        b.status === 'running' ? { ...b, status: 'failed' as const, endedAt: at, reason } : b,
      ),
    }),
    at,
  )
  changed(deps, agentId, 'beat')
}
