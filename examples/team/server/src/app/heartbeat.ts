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

import { conflict, invalid } from '../domain/errors.ts'
import {
  activityLines,
  activityTotal,
  type BeatDecision,
  type BeatItem,
  type BeatRecord,
  type BeatTrigger,
  beatPrompt,
  boardLine,
  buildDigest,
  CHECKLIST_SUGGESTION,
  CHECKLIST_TEMPLATE,
  type ChatActivity,
  checkDigestFields,
  checkHeartbeatFields,
  checklistIsEmpty,
  checklistPath,
  checkPost,
  DIGEST_KEY,
  type DigestConfig,
  type DigestState,
  dailyCron,
  defaultHeartbeat,
  type Finding,
  type HeartbeatConfig,
  type HeartbeatDestination,
  type HeartbeatDestinationView,
  type HeartbeatState,
  heartbeatKey,
  inActiveHours,
  localDay,
  MAX_DIGEST_BUFFER,
  MAX_POST_HISTORY_MS,
  noteLine,
  notesPath,
  observe,
  parseBeatResult,
  periodStarts,
  postsToday,
  pruneFingerprints,
  pushBeat,
  type RequestText,
  splitNew,
  statusText,
  type WatchNode,
  watchedNodes,
} from '../domain/heartbeat.ts'
import { parseProgramSession } from '../domain/programs.ts'
import type { RoutineSpec } from '../domain/routines.ts'
import { boardColumn, type Task } from '../domain/tasks.ts'
import { getAgent } from './agents.ts'
import { postAlerts, postBriefing } from './briefings.ts'
import { healthSummary } from './health.ts'
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
  checklist: {
    path: string
    exists: boolean
    /** Nothing to check (only headings and comments): every beat is skipped, no model call. */
    empty: boolean
    /** A short starting point the owner may insert (never written by itself). */
    suggestion: string
  }
  /** Places a beat may report to (chosen from this list). */
  destinations: HeartbeatDestinationView[]
  /** The chats an activity wake and the beat's activity summary look at (the watch rule). */
  watched: Array<{ nodeId: string; title: string }>
  /** Posts the beat made to `reportTo` today (local day of its timezone). */
  postsToday: number
  /** Today's observation notes (library file, team timezone). */
  notes: { path: string; exists: boolean }
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

/** The stored config over the defaults (a config stored before a field existed gets its default). */
export function effectiveConfig(deps: Deps, agent: { id: string; role: string }): HeartbeatConfig {
  const stored = deps.heartbeat.store.config(agent.id)
  const merged = { ...defaultHeartbeat(agent), ...stored }
  // a config stored before modes existed keeps its meaning: with a report chat it may speak
  return { ...merged, mode: stored?.mode ?? (merged.reportTo === null ? 'notes' : 'speak') }
}

/** The timezone in effect for an agent's active hours: its own, else the team's. */
export const heartbeatTimezone = (deps: Deps, config: HeartbeatConfig): string =>
  config.timezone ?? deps.settings.get().timezone

export async function getHeartbeat(deps: Deps, idOrSlug: string): Promise<HeartbeatView> {
  const agent = getAgent(deps, idOrSlug)
  const file = await deps.library.read(checklistPath(agent.id))
  const routine = deps.routines.getByProgram(heartbeatKey(agent.id))
  const config = effectiveConfig(deps, agent)
  const timezone = heartbeatTimezone(deps, config)
  return {
    agentId: agent.id,
    config,
    effectiveTimezone: timezone,
    stored: deps.heartbeat.store.config(agent.id) !== undefined,
    checklist: {
      path: checklistPath(agent.id),
      exists: file !== undefined,
      empty: checklistIsEmpty(file?.text),
      suggestion: CHECKLIST_SUGGESTION,
    },
    destinations: deps.heartbeat.channels?.destinations(agent.id) ?? [],
    watched: watchedOf(deps, agent.id, file?.text ?? '').map((n) => ({
      nodeId: n.nodeId,
      title: n.title,
    })),
    postsToday: postsToday(deps.heartbeat.store.state(agent.id).posts, deps.clock.now(), timezone),
    notes: await todaysNotes(deps, agent),
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

const DAY_MS = 24 * 3_600_000

/** Today's notes file of an agent (day of the team timezone) and whether it exists. */
async function todaysNotes(
  deps: Deps,
  agent: { slug: string },
): Promise<{ path: string; exists: boolean }> {
  const path = notesPath(agent.slug, localDay(deps.clock.now(), deps.settings.get().timezone))
  return { path, exists: (await deps.library.read(path)) !== undefined }
}

/**
 * Append one line to today's notes (append-only, one file per day). The only write a beat has, and
 * it can only reach this path pattern: the path is built here, never taken from the model.
 */
export async function appendNote(
  deps: Deps,
  agentId: string,
  entry: { chat: string; messageIds?: string[]; noticed: string; decision: BeatDecision },
): Promise<string> {
  const agent = getAgent(deps, agentId)
  const config = effectiveConfig(deps, agent)
  if (config.mode === 'off') return 'Notes are off for this heartbeat (mode off).'
  if (entry.noticed.trim() === '' || entry.chat.trim() === '')
    return 'ERROR: a note needs chat and noticed.'
  const now = deps.clock.now()
  const tz = deps.settings.get().timezone
  const day = localDay(now, tz)
  const path = notesPath(agent.slug, day)
  const current = (await deps.library.read(path))?.text ?? `# Heartbeat notes ${day}\n\n`
  await deps.library.writeText(
    path,
    `${current.replace(/\s*$/, '\n')}${noteLine(now, tz, entry)}\n`,
  )
  return `Noted in ${path}.`
}

/** The chats this agent's beat watches for new messages (`watchedNodes`). */
function watchedOf(deps: Deps, agentId: string, checklist: string): WatchNode[] {
  const nodes = deps.heartbeat.channels?.nodes(agentId) ?? []
  return watchedNodes(nodes, checklist)
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
  // a report destination is a conversation of one of the agent's own connections, nothing else
  if (clean.reportTo != null) {
    const to = clean.reportTo
    const known = deps.heartbeat.channels
      ?.destinations(agent.id)
      .some((d) => d.connectionId === to.connectionId && d.nodeId === to.nodeId)
    if (known !== true) {
      throw invalid(
        'reportTo must be a chat or topic of one of the connections bound to this agent',
        'INVALID_HEARTBEAT',
      )
    }
    clean.reportTo = { connectionId: to.connectionId, nodeId: to.nodeId }
  }
  const next: HeartbeatConfig = { ...effectiveConfig(deps, agent), ...clean }
  // the mode stays derived (a report chat means `speak`) until somebody chooses one
  if (clean.mode === undefined && deps.heartbeat.store.config(agent.id)?.mode === undefined) {
    delete (next as Partial<HeartbeatConfig>).mode
  }
  deps.heartbeat.store.setConfig(agent.id, next, deps.clock.now())
  // turning it on gives the person a file to write the checklist in
  if (
    createChecklist === true &&
    (await deps.library.read(checklistPath(agent.id))) === undefined
  ) {
    await deps.library.writeText(checklistPath(agent.id), CHECKLIST_TEMPLATE, null)
  }
  syncHeartbeatRoutine(deps, agent.id)
  // a team without a lead still gets its digest once an agent has a heartbeat
  syncDigestRoutine(deps)
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
  // the digest is built from data, not by an agent: its routine row only needs a host. A team
  // with no `lead` (all agents custom) still gets it, hosted by the first agent that beats
  const l =
    lead(deps) ??
    deps.agents.list().find((a) => effectiveConfig(deps, a).enabled) ??
    deps.agents.list()[0]
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
  // Month and today are both calendar periods of the team timezone, so today can never exceed
  // the month. The budget ledger counts in UTC months and is not pruned; the call log is pruned
  // but follows the team timezone: each is a lower bound of the real spend, so the month shown is
  // the larger of the two (it never reads below what the log shows for today).
  const { dayStart, monthStart } = periodStarts(now, deps.settings.get().timezone)
  const ledger = await deps.heartbeat.budget()
  const logMonth = deps.modelCalls.stats({ from: monthStart, to: now }).totals.costUsd
  const monthSpent = Math.max(ledger?.spentUsd ?? 0, logMonth)
  const todaySpent = deps.modelCalls.stats({ from: dayStart, to: now }).totals.costUsd
  const spend = {
    month: ledger === null ? null : { spentUsd: monthSpent, limitUsd: ledger.limitUsd },
    todayUsd: Math.min(todaySpent, monthSpent),
  }
  const board = boardLine(deps.tasks.list({ limit: 300 }))
  const activity = await activityOf(deps, agentId, state.window?.since ?? now - HOUR, now)
  const lines = activityLines(activity, state.window)
  return {
    text: statusText(fresh, now, spend, [board, ...lines].join('\n')),
    findings: fresh,
  }
}

/** New messages per watched chat of an agent in `[since, until)` (none without channels). */
async function activityOf(
  deps: Deps,
  agentId: string,
  since: number,
  until: number,
): Promise<ChatActivity[]> {
  const channels = deps.heartbeat.channels
  if (channels === undefined) return []
  const agent = getAgent(deps, agentId)
  const file = await deps.library.read(checklistPath(agent.id))
  const watched = watchedOf(deps, agent.id, file?.text ?? '')
  if (watched.length === 0) return []
  return channels.activity(watched, since, until)
}

// --- posting and waking from chats -------------------------------------------------------------

/** Where the beat may post, and how many posts a day (the gate reads this on every call). */
export function postingOf(
  deps: Deps,
  agentId: string,
): { reportTo: HeartbeatDestination | null; maxPostsPerDay: number } {
  const agent = getAgent(deps, agentId)
  const { reportTo, maxPostsPerDay, mode } = effectiveConfig(deps, agent)
  // only the `speak` mode may post: in `notes` the destination is where the owner reads, nothing more
  return { reportTo: mode === 'speak' ? reportTo : null, maxPostsPerDay }
}

/**
 * The beat is about to post `text` to its destination: refuse it (a readable reason the model can
 * act on) over the daily cap or for a repeat, else count it. The count is taken here, before the
 * send, so two posts in one step cannot both slip under the cap; a post the gateway then refuses
 * still uses one.
 */
export function reservePost(
  deps: Deps,
  agentId: string,
  text: string,
  now = deps.clock.now(),
): string | undefined {
  const agent = getAgent(deps, agentId)
  const config = effectiveConfig(deps, agent)
  const timezone = heartbeatTimezone(deps, config)
  let refusal: string | undefined
  deps.heartbeat.store.updateState(
    agentId,
    (s) => {
      const checked = checkPost(s, config, text, now, timezone)
      if (!checked.ok) {
        refusal = checked.reason
        return s
      }
      return {
        ...s,
        fingerprints: { ...s.fingerprints, [checked.fingerprint]: now },
        posts: [...(s.posts ?? []).filter((at) => now - at < MAX_POST_HISTORY_MS), now],
      }
    },
    now,
  )
  return refusal
}

/**
 * New messages arrived in a chat: should an early beat run, and how soon? Cheap and pure over the
 * stores: the agent's beat is on and wakes on activity, the chat is one it watches (`watchedNodes`),
 * inside the active hours, and an activity beat starts at the earliest `minGapMinutes` after the
 * previous beat that ran. undefined = no.
 */
export async function planActivityWake(
  deps: Deps,
  input: { connectionId: string; nodeId: string; at: number },
): Promise<{ agentId: string; notBefore: number } | undefined> {
  const channels = deps.heartbeat.channels
  const agentId = channels?.agentOf(input.connectionId)
  if (channels === undefined || agentId === undefined) return undefined
  const agent = deps.agents.get(agentId)
  if (agent === undefined || agent.archivedAt !== null) return undefined
  const config = effectiveConfig(deps, agent)
  if (!config.enabled || !config.wakeOnActivity) return undefined
  if (!inActiveHours(input.at, { ...config, timezone: heartbeatTimezone(deps, config) })) {
    return undefined
  }
  const file = await deps.library.read(checklistPath(agent.id))
  if (checklistIsEmpty(file?.text)) return undefined
  const watched = watchedOf(deps, agent.id, file?.text ?? '')
  if (!watched.some((n) => n.nodeId === input.nodeId)) return undefined
  const last = deps.heartbeat.store.state(agent.id).last
  return {
    agentId,
    notBefore: last === undefined ? input.at : last.at + config.minGapMinutes * 60_000,
  }
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
  input: {
    id: string
    at: number
    session: { busy: boolean; waiting: boolean }
    /** What started it (default: the interval). */
    trigger?: BeatTrigger
  },
): Promise<BeatPlan> {
  const agent = getAgent(deps, agentId)
  const config = effectiveConfig(deps, agent)
  const { at } = input
  const trigger: BeatTrigger = input.trigger ?? 'schedule'
  const skip = (reason: string): BeatPlan => {
    // an early beat that does not start is not worth a line in the history
    if (trigger === 'activity') return { run: false, reason }
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
  if (trigger === 'activity') {
    if (!config.wakeOnActivity) return skip('waking on activity is off')
    if (state.last !== undefined && at - state.last.at < config.minGapMinutes * 60_000) {
      return skip('too soon after the previous beat')
    }
  }
  // the window of this beat: the chats' new messages since the last beat that ran
  const since = state.last?.at ?? at - config.everyMinutes * 60_000
  if (trigger === 'activity') {
    const activity = await activityOf(deps, agent.id, since, at)
    if (activityTotal(activity) === 0) return skip('no new activity')
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
  deps.heartbeat.store.updateState(
    agent.id,
    (s) => ({ ...s, last: { at, trigger }, window: { since, trigger } }),
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
    trigger,
  })
  const day = localDay(at, deps.settings.get().timezone)
  const yesterday = localDay(at - DAY_MS, deps.settings.get().timezone)
  const destination =
    config.mode !== 'speak' || config.reportTo === null || config.maxPostsPerDay === 0
      ? undefined
      : deps.heartbeat.channels
          ?.destinations(agent.id)
          .find(
            (d) =>
              d.connectionId === config.reportTo?.connectionId &&
              d.nodeId === config.reportTo?.nodeId,
          )
  const postsLeft = Math.max(
    0,
    config.maxPostsPerDay - postsToday(deps.heartbeat.store.state(agent.id).posts, at, timezone),
  )
  return {
    run: true,
    prompt: beatPrompt({
      now: at,
      timezone,
      checklist: file?.text ?? '',
      agentName: agent.name,
      trigger,
      mode: config.mode,
      notes: [notesPath(agent.slug, day), notesPath(agent.slug, yesterday)],
      report:
        destination === undefined || postsLeft === 0
          ? null
          : {
              connectionId: destination.connectionId,
              nodeId: destination.nodeId,
              label: destination.label,
              postsLeft,
            },
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
        ...(open?.trigger === undefined ? {} : { trigger: open.trigger }),
      }
      const beats =
        open === undefined
          ? pushBeat(s.beats, record)
          : s.beats.map((b) => (b.id === open.id ? (record as BeatRecord) : b))
      return {
        ...s,
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
    // an item that was only noted stays in the beat log and the notes: the digest is for what
    // the owner should see (a note per chat message would bury it)
    const forDigest = fresh.filter((i) => i.decision !== 'note')
    if (forDigest.length > 0) {
      deps.heartbeat.store.updateDigest(
        (d) => ({
          ...d,
          buffer: [...d.buffer, ...forDigest.map((item) => ({ at, agentId, item }))].slice(
            -MAX_DIGEST_BUFFER,
          ),
        }),
        at,
      )
    }
    // an escalation is an owner notice at once, like an urgent finding
    const urgent = fresh.filter((i) => i.urgent || i.decision === 'escalate')
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
    // what the Health page found (a failed scan never stops the digest)
    ...(await healthSummary(deps)
      .then((h) => ({ health: { open: h.open, high: h.high } }))
      .catch(() => ({}))),
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
