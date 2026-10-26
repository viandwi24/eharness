/**
 * Scripts use cases (docs/plans/P59-scripts-and-tables.md, ADR-0065): store scripts as immutable
 * versions, dry-run and run them, activate them, and keep their schedule routine in step.
 *
 * Who may do what:
 *  - A person (the web owner, an owner/admin through an agent tool is still an *agent* author) may
 *    create, update, activate any version, approve or reject, disable, enable and delete.
 *  - An agent may create and update (new versions), dry-run, disable, delete and ask for
 *    activation. A script an agent wrote runs only after a person approved that version, except
 *    a new version of an approved, active script that widens nothing (same triggers, no wider
 *    grants, no looser caps): that one the agent may switch to itself.
 *
 * Bad input is a `DomainError` with a sentence (HTTP 400/404/409; agent tools `ERROR:` lines).
 */
import { conflict, DomainError, invalid, notFound } from '../domain/errors.ts'
import { scriptKey } from '../domain/heartbeat.ts'
import type { RoutineSpec } from '../domain/routines.ts'
import {
  CHANNEL_EVENT_TYPES,
  type ChannelEventType,
  channelMismatch,
  grantWidening,
  parseManifest,
  ROLES,
  type Role,
  type ScheduleTrigger,
  type ScriptChannelEvent,
  type ScriptManifest,
} from '../domain/script-manifest.ts'
import {
  type HostMethodDoc,
  KV_LIMITS,
  type Script,
  type ScriptRun,
  type ScriptVersion,
  scriptNameProblem,
} from '../domain/scripts.ts'
import type { Deps, ScriptRunnerPort } from './ports.ts'

/** Who acts: a person (the web owner) or an agent (its tool). */
export type ScriptActor =
  | { kind: 'person'; name: string }
  | { kind: 'agent'; agentId: string; name: string }

export const WEB_OWNER: ScriptActor = { kind: 'person', name: 'web owner' }

export const MAX_SOURCE_CHARS = 200_000
const MAX_DESCRIPTION = 500
const MAX_NOTE = 500
/** Runs kept per script, and the age after which runs go (retention). */
export const RUNS_KEEP_PER_SCRIPT = 500
export const RUNS_KEEP_DAYS = 30

const APPROVAL_KEY = 'script-approval:'

function runner(deps: Deps): ScriptRunnerPort {
  const r = deps.scriptRunner?.()
  if (r === undefined)
    throw new DomainError('conflict', 'SCRIPTS_UNAVAILABLE', 'the scripts engine is not running')
  return r
}

const changed = (
  deps: Deps,
  s: Pick<Script, 'id' | 'name'>,
  change: string,
  extra: Record<string, unknown> = {},
): void =>
  deps.events.append({
    type: 'scripts-changed',
    payload: { script: s.name, scriptId: s.id, change, ...extra },
  })

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The manifest of input, or a 400 listing every problem. */
export function manifestOf(input: unknown): ScriptManifest {
  const parsed = parseManifest(input)
  if (!parsed.ok)
    throw invalid(`The manifest has problems: ${parsed.errors.join('; ')}`, 'INVALID_MANIFEST')
  return parsed.value
}

/** The manifest stored with a version (it was valid when stored). */
export function versionManifest(v: ScriptVersion): ScriptManifest {
  const parsed = parseManifest(v.manifest)
  if (!parsed.ok)
    throw invalid(
      `The manifest of version ${v.version} has problems: ${parsed.errors.join('; ')}`,
      'INVALID_MANIFEST',
    )
  return parsed.value
}

function checkSource(deps: Deps, source: string): void {
  if (typeof source !== 'string' || source.trim() === '')
    throw invalid('The source is empty', 'INVALID_SOURCE')
  if (source.length > MAX_SOURCE_CHARS)
    throw invalid(`The source is longer than ${MAX_SOURCE_CHARS} characters`, 'INVALID_SOURCE')
  const problem = runner(deps).check(source)
  if (problem !== undefined) throw invalid(problem, 'INVALID_SOURCE')
}

/** Every schedule spec of the manifest must be a valid routine schedule. */
function checkSchedule(deps: Deps, m: ScriptManifest): void {
  const t = m.triggers.find((x): x is ScheduleTrigger => x.kind === 'schedule')
  if (t === undefined) return
  try {
    deps.schedule.validate(routineSpec(deps, t))
  } catch (error) {
    if (error instanceof DomainError)
      throw invalid(`The schedule trigger: ${error.message}`, 'INVALID_MANIFEST')
    throw error
  }
}

/** A manifest schedule as a routine schedule (cron gets the team timezone unless it names one). */
export function routineSpec(deps: Deps, t: ScheduleTrigger): RoutineSpec {
  const s = t.spec
  if (s.kind === 'cron') {
    if (typeof s.expr !== 'string' || s.expr.trim() === '')
      throw invalid('a cron schedule needs expr ("0 9 * * *")', 'INVALID_MANIFEST')
    const tz =
      typeof s.timezone === 'string' && s.timezone !== ''
        ? s.timezone
        : typeof s.tz === 'string' && s.tz !== ''
          ? s.tz
          : deps.settings.get().timezone
    return { kind: 'cron', expr: s.expr.trim(), tz }
  }
  if (s.kind === 'every') {
    if (typeof s.everyMs !== 'number' || !Number.isInteger(s.everyMs) || s.everyMs < 60_000)
      throw invalid(
        'an every schedule needs everyMs of at least 60000 (one minute)',
        'INVALID_MANIFEST',
      )
    return { kind: 'every', everyMs: s.everyMs }
  }
  if (s.kind === 'at') {
    const at =
      typeof s.at === 'number' ? s.at : typeof s.at === 'string' ? Date.parse(s.at) : Number.NaN
    if (!Number.isFinite(at))
      throw invalid('an at schedule needs at (epoch ms or an ISO date)', 'INVALID_MANIFEST')
    return { kind: 'at', at }
  }
  throw invalid(
    'a schedule is { kind: "cron", expr, timezone? }, { kind: "every", everyMs } or { kind: "at", at }',
    'INVALID_MANIFEST',
  )
}

function agentIdOf(deps: Deps, ref: string): string {
  const a = deps.agents.get(ref) ?? deps.agents.getBySlug(ref)
  if (a === undefined) throw invalid(`No agent "${ref}"`, 'INVALID_AGENT')
  return a.id
}

// --- reading -----------------------------------------------------------------------------------

export function listScripts(deps: Deps): Script[] {
  return deps.scripts.list()
}

export function getScript(deps: Deps, ref: string): Script {
  const s = deps.scripts.get(ref)
  if (s === undefined) throw notFound('Script', ref)
  return s
}

export function getVersion(deps: Deps, ref: string, version?: number): ScriptVersion {
  const s = getScript(deps, ref)
  const n = version ?? s.latestVersion
  const v = deps.scripts.version(s.id, n)
  if (v === undefined) throw notFound('Version', `${s.name} v${n}`)
  return v
}

export function listVersions(deps: Deps, ref: string): ScriptVersion[] {
  return deps.scripts.versions(getScript(deps, ref).id)
}

export function listRuns(
  deps: Deps,
  ref: string,
  q: { limit?: number | undefined; before?: string | undefined; dryRun?: boolean | undefined } = {},
): ScriptRun[] {
  const s = getScript(deps, ref)
  return deps.scripts.runs(s.id, {
    limit: Math.min(Math.max(q.limit ?? 50, 1), 200),
    before: q.before,
    dryRun: q.dryRun,
  })
}

export function getRun(deps: Deps, ref: string, runId: string): ScriptRun {
  const s = getScript(deps, ref)
  const r = deps.scripts.run(runId)
  if (r === undefined || r.scriptId !== s.id) throw notFound('Run', runId)
  return r
}

export function scriptTypesText(deps: Deps): { types: string; methods: readonly HostMethodDoc[] } {
  const r = runner(deps)
  return { types: r.types(), methods: r.methods() }
}

/** The key-value state of a script (the Scripts page shows it). */
export function scriptKv(
  deps: Deps,
  ref: string,
  prefix = '',
): Array<{ key: string; value: string }> {
  const s = getScript(deps, ref)
  return deps.scripts
    .kvKeys(s.id, prefix)
    .slice(0, KV_LIMITS.keys)
    .map((key) => ({ key, value: deps.scripts.kvGet(s.id, key) ?? '' }))
}

// --- writing -----------------------------------------------------------------------------------

export interface ScriptInput {
  name: string
  description?: string | undefined
  /** The agent the script belongs to (its chats, its wake target); agents always use their own. */
  agent?: string | undefined
  source: string
  manifest: unknown
  note?: string | undefined
}

export async function createScript(
  deps: Deps,
  actor: ScriptActor,
  input: ScriptInput,
): Promise<Script> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const bad = scriptNameProblem(name)
  if (bad !== undefined) throw invalid(bad, 'INVALID_NAME')
  if (deps.scripts.get(name) !== undefined)
    throw conflict(`A script named "${name}" exists already`, 'SCRIPT_EXISTS')
  const manifest = manifestOf(input.manifest)
  checkSchedule(deps, manifest)
  checkSource(deps, input.source)
  let agentId: string
  if (actor.kind === 'agent') agentId = actor.agentId
  else if (input.agent !== undefined && input.agent !== '') agentId = agentIdOf(deps, input.agent)
  else {
    const first = deps.agents.list()[0]
    if (first === undefined) throw invalid('Name the agent the script belongs to', 'INVALID_AGENT')
    agentId = first.id
  }
  const s = deps.scripts.insert(
    {
      id: deps.ids.next(),
      name,
      description: (input.description ?? '').trim().slice(0, MAX_DESCRIPTION),
      agentId,
      authorKind: actor.kind,
      createdBy: actor.name,
      now: deps.clock.now(),
    },
    {
      source: input.source,
      manifest: manifest as unknown as Record<string, unknown>,
      hash: await sha256(input.source),
      note: (input.note ?? 'first version').slice(0, MAX_NOTE),
    },
  )
  changed(deps, s, 'created', { by: actor.name })
  return s
}

export interface ScriptPatch {
  /** A new version when source or manifest is given (the other part is copied from the latest). */
  source?: string | undefined
  manifest?: unknown
  note?: string | undefined
  description?: string | undefined
  /** Persons only. */
  agent?: string | undefined
  name?: string | undefined
}

/**
 * Update a script. Code or manifest changes add a version; the running version does not change
 * (activate the new one). Returns the script and the new version number, if any.
 */
export async function updateScript(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  patch: ScriptPatch,
): Promise<{ script: Script; version?: number }> {
  const s = getScript(deps, ref)
  const now = deps.clock.now()
  const fields: Parameters<Deps['scripts']['update']>[1] = {}
  if (patch.description !== undefined)
    fields.description = patch.description.trim().slice(0, MAX_DESCRIPTION)
  if (patch.name !== undefined && patch.name !== s.name) {
    const bad = scriptNameProblem(patch.name)
    if (bad !== undefined) throw invalid(bad, 'INVALID_NAME')
    if (deps.scripts.get(patch.name) !== undefined)
      throw conflict(`A script named "${patch.name}" exists already`, 'SCRIPT_EXISTS')
    fields.name = patch.name
  }
  if (patch.agent !== undefined) {
    if (actor.kind === 'agent')
      throw new DomainError(
        'forbidden',
        'FORBIDDEN',
        'An agent cannot move a script to another agent',
      )
    fields.agentId = agentIdOf(deps, patch.agent)
  }
  let version: number | undefined
  if (patch.source !== undefined || patch.manifest !== undefined) {
    const latest = getVersion(deps, s.id)
    const source = patch.source ?? latest.source
    const manifest =
      patch.manifest === undefined ? versionManifest(latest) : manifestOf(patch.manifest)
    checkSchedule(deps, manifest)
    checkSource(deps, source)
    const hash = await sha256(source)
    const same =
      hash === latest.hash && JSON.stringify(manifest) === JSON.stringify(versionManifest(latest))
    if (!same) {
      version = deps.scripts.addVersion(
        s.id,
        {
          source,
          manifest: manifest as unknown as Record<string, unknown>,
          hash,
          note: (patch.note ?? '').slice(0, MAX_NOTE),
          createdBy: actor.name,
          authorKind: actor.kind,
        },
        now,
      )
    }
  }
  const after =
    Object.keys(fields).length > 0
      ? (deps.scripts.update(s.id, fields, now) ?? s)
      : (deps.scripts.get(s.id) ?? s)
  if (fields.agentId !== undefined) syncSchedule(deps, after)
  if (version !== undefined || Object.keys(fields).length > 0)
    changed(deps, after, version === undefined ? 'updated' : 'version', {
      by: actor.name,
      ...(version === undefined ? {} : { version }),
    })
  return { script: after, ...(version === undefined ? {} : { version }) }
}

/** Why version `to` needs a person's approval compared with what runs now; [] = it widens nothing. */
export function wideningOf(deps: Deps, s: Script, to: ScriptVersion): string[] {
  if (s.status !== 'active' || s.activeVersion === null || s.approval.state !== 'approved')
    return ['the script is not running an approved version']
  const from = deps.scripts.version(s.id, s.activeVersion)
  if (from === undefined) return ['the running version is missing']
  const a = versionManifest(from)
  const b = versionManifest(to)
  const out = grantWidening(a.grants, b.grants)
  if (JSON.stringify(a.triggers) !== JSON.stringify(b.triggers)) out.push('the triggers change')
  if (b.cooldownSec < a.cooldownSec) out.push('a shorter cooldown')
  if (a.maxRunsPerHour !== 0 && (b.maxRunsPerHour === 0 || b.maxRunsPerHour > a.maxRunsPerHour))
    out.push('more runs per hour')
  if (JSON.stringify(a.limits) !== JSON.stringify(b.limits)) out.push('other limits')
  return out
}

function setActive(
  deps: Deps,
  s: Script,
  version: number,
  by: string,
  note: string | null,
): Script {
  const now = deps.clock.now()
  const after =
    deps.scripts.update(
      s.id,
      {
        status: 'active',
        activeVersion: version,
        approvalState: 'approved',
        approvalVersion: version,
        approvalBy: by,
        approvalAt: now,
        approvalNote: note,
        disabledReason: null,
        consecutiveFailures: 0,
      },
      now,
    ) ?? s
  deps.notifications.dismissByKeyPrefix(`${APPROVAL_KEY}${s.id}:`, now)
  syncSchedule(deps, after)
  return after
}

/**
 * Run version `version` (default the latest). A person activates directly. An agent switches only
 * when nothing widens; otherwise the request waits for a person (`pending` + a bell notification).
 */
export function activateScript(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  options: { version?: number | undefined; note?: string | undefined } = {},
): { script: Script; state: 'active' | 'pending'; reasons: string[] } {
  const s = getScript(deps, ref)
  const v = getVersion(deps, s.id, options.version)
  if (actor.kind === 'person') {
    const after = setActive(deps, s, v.version, actor.name, options.note ?? null)
    changed(deps, after, 'activated', { by: actor.name, version: v.version })
    return { script: after, state: 'active', reasons: [] }
  }
  if (actor.agentId !== s.agentId)
    throw new DomainError(
      'forbidden',
      'FORBIDDEN',
      'Only the agent the script belongs to may ask for its activation',
    )
  // an approved version (approved by a person before) may be switched back to
  const reasons =
    s.approval.state === 'approved' && s.approval.version === v.version
      ? []
      : wideningOf(deps, s, v)
  if (reasons.length === 0) {
    const after = setActive(
      deps,
      s,
      v.version,
      s.approval.by ?? actor.name,
      `switched by ${actor.name}; widens nothing`,
    )
    changed(deps, after, 'activated', { by: actor.name, version: v.version })
    return { script: after, state: 'active', reasons }
  }
  const now = deps.clock.now()
  const after =
    deps.scripts.update(
      s.id,
      {
        approvalState: 'pending',
        approvalVersion: v.version,
        approvalBy: actor.name,
        approvalAt: now,
        approvalNote: (options.note ?? '').slice(0, MAX_NOTE) || null,
      },
      now,
    ) ?? s
  deps.notifications.dismissByKeyPrefix(`${APPROVAL_KEY}${s.id}:`, now)
  const n = deps.notifications.insert({
    id: deps.ids.next(),
    kind: 'alert',
    key: `${APPROVAL_KEY}${s.id}:${v.version}`,
    title: `Script "${s.name}" v${v.version} waits for your approval`,
    body: `${actor.name} asks to run it. ${reasons.join('; ')}.${options.note ? ` Note: ${options.note.slice(0, 300)}` : ''} Review the code and grants on the Scripts page.`
      .replace(/\s+/g, ' ')
      .slice(0, 600),
    link: `/scripts/${s.name}`,
    agentId: s.agentId,
    createdAt: now,
  })
  if (n !== undefined)
    deps.events.append({ type: 'notification-changed', payload: { kind: 'alert', added: 1 } })
  changed(deps, after, 'approval-requested', { by: actor.name, version: v.version })
  return { script: after, state: 'pending', reasons }
}

/** A person answers a pending request: yes runs that version, no keeps what runs now. */
export function decideApproval(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  answer: { approve: boolean; version?: number | undefined; note?: string | undefined },
): Script {
  if (actor.kind !== 'person')
    throw new DomainError('forbidden', 'FORBIDDEN', 'Only a person approves scripts')
  const s = getScript(deps, ref)
  if (s.approval.state !== 'pending' || s.approval.version === null)
    throw conflict(`Script "${s.name}" has no request waiting`, 'ALREADY_ANSWERED')
  if (answer.version !== undefined && answer.version !== s.approval.version)
    throw conflict(
      `The request is for version ${s.approval.version}, not ${answer.version}`,
      'ALREADY_ANSWERED',
    )
  if (answer.approve) {
    const after = setActive(deps, s, s.approval.version, actor.name, answer.note ?? null)
    changed(deps, after, 'approved', { by: actor.name, version: s.approval.version })
    return after
  }
  const now = deps.clock.now()
  const running = s.activeVersion !== null && s.status === 'active'
  const after =
    deps.scripts.update(
      s.id,
      running
        ? {
            approvalState: 'approved',
            approvalVersion: s.activeVersion,
            approvalNote:
              `v${s.approval.version} rejected by ${actor.name}${answer.note ? `: ${answer.note}` : ''}`.slice(
                0,
                MAX_NOTE,
              ),
          }
        : {
            approvalState: 'rejected',
            approvalBy: actor.name,
            approvalAt: now,
            approvalNote: (answer.note ?? '').slice(0, MAX_NOTE) || null,
          },
      now,
    ) ?? s
  deps.notifications.dismissByKeyPrefix(`${APPROVAL_KEY}${s.id}:`, now)
  changed(deps, after, 'rejected', { by: actor.name, version: s.approval.version })
  return after
}

export function disableScript(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  reason = 'manual',
): Script {
  const s = getScript(deps, ref)
  if (actor.kind === 'agent' && actor.agentId !== s.agentId)
    throw new DomainError(
      'forbidden',
      'FORBIDDEN',
      'Only the agent the script belongs to may switch it off',
    )
  const after =
    deps.scripts.update(s.id, { status: 'disabled', disabledReason: reason }, deps.clock.now()) ?? s
  syncSchedule(deps, after)
  changed(deps, after, 'disabled', { by: actor.name, reason })
  return after
}

/** Turn a switched-off script on again with the version it ran (a person only). */
export function enableScript(deps: Deps, actor: ScriptActor, ref: string): Script {
  if (actor.kind !== 'person')
    throw new DomainError('forbidden', 'FORBIDDEN', 'Only a person turns a script on')
  const s = getScript(deps, ref)
  const version = s.activeVersion ?? s.approval.version
  if (version === null)
    throw conflict(`Script "${s.name}" was never activated: activate a version`, 'NOT_ACTIVATED')
  const after = setActive(deps, s, version, actor.name, s.approval.note)
  changed(deps, after, 'enabled', { by: actor.name, version })
  return after
}

export function deleteScript(deps: Deps, actor: ScriptActor, ref: string): void {
  const s = getScript(deps, ref)
  if (actor.kind === 'agent' && actor.agentId !== s.agentId)
    throw new DomainError(
      'forbidden',
      'FORBIDDEN',
      'Only the agent the script belongs to may delete it',
    )
  const routine = deps.routines.getByProgram(scriptKey(s.id))
  if (routine !== undefined) deps.routines.delete(routine.id)
  deps.notifications.dismissByKeyPrefix(`${APPROVAL_KEY}${s.id}:`, deps.clock.now())
  deps.scripts.delete(s.id)
  changed(deps, s, 'deleted', { by: actor.name })
}

/**
 * The schedule routine (`sys:script:<id>`) follows the script: there while active with a
 * schedule trigger, retimed when the schedule changes, gone otherwise.
 */
export function syncSchedule(deps: Deps, s: Script): void {
  const key = scriptKey(s.id)
  const existing = deps.routines.getByProgram(key)
  const v =
    s.status === 'active' && s.activeVersion !== null
      ? deps.scripts.version(s.id, s.activeVersion)
      : undefined
  const trigger =
    v === undefined
      ? undefined
      : versionManifest(v).triggers.find((t): t is ScheduleTrigger => t.kind === 'schedule')
  const now = deps.clock.now()
  if (trigger === undefined) {
    if (existing !== undefined) deps.routines.delete(existing.id)
    if (s.routineId !== null) deps.scripts.update(s.id, { routineId: null }, now)
    return
  }
  const spec = routineSpec(deps, trigger)
  deps.schedule.validate(spec)
  if (existing === undefined) {
    const r = deps.routines.insert({
      id: deps.ids.next(),
      agentId: s.agentId,
      name: `Script ${s.name}`.slice(0, 120),
      prompt: '',
      schedule: spec,
      sessionMode: 'task',
      overlap: 'skip',
      catchUpWindowMs: null,
      maxFailures: 100,
      maxFires: null,
      endAt: null,
      nextFireAt: deps.schedule.next(spec, now),
      programId: key,
      now,
    })
    deps.scripts.update(s.id, { routineId: r.id }, now)
    return
  }
  const same = JSON.stringify(existing.schedule) === JSON.stringify(spec)
  if (!same || existing.status !== 'active' || existing.agentId !== s.agentId) {
    deps.routines.update(
      existing.id,
      {
        schedule: spec,
        status: 'active',
        pausedReason: null,
        failures: 0,
        nextFireAt:
          same && existing.nextFireAt !== null
            ? existing.nextFireAt
            : deps.schedule.next(spec, now),
      },
      now,
    )
  }
  if (s.routineId !== existing.id) deps.scripts.update(s.id, { routineId: existing.id }, now)
}

// --- running -----------------------------------------------------------------------------------

export interface DryRunInput {
  version?: number | undefined
  /** A channel event of the Events page (`ch:<id>`): its facts, plus `text` as the message text. */
  eventId?: string | undefined
  /** A synthetic event (any JSON); a channel event when it has a channel `type`. */
  event?: unknown
  /** The message text for a recorded event (the event log never keeps message text). */
  text?: string | undefined
}

export interface DryRunResult {
  run: ScriptRun
  /** For a channel event: per channel trigger, `match` or why it would not start the script. */
  triggers: string[]
}

/** A channel event from a record of the Events page, with the text the caller gives. */
async function recordedEvent(
  deps: Deps,
  eventId: string,
  text: string | undefined,
): Promise<ScriptChannelEvent> {
  const e = await deps.eventStream.get(eventId)
  if (e === undefined) throw notFound('Event', eventId)
  if (
    e.source !== 'channel' ||
    e.connectionId === undefined ||
    !(CHANNEL_EVENT_TYPES as readonly string[]).includes(e.type)
  )
    throw invalid(`Event ${eventId} is not a channel event a script can start on`, 'INVALID_EVENT')
  const room =
    e.chat?.roomId === undefined
      ? undefined
      : await deps.channels.chat(e.connectionId, e.chat.roomId).catch(() => undefined)
  const role =
    e.actor?.role !== undefined && (ROLES as readonly string[]).includes(e.actor.role)
      ? (e.actor.role as Role)
      : undefined
  return {
    type: e.type as ChannelEventType,
    connectionId: e.connectionId,
    eventId: e.id,
    at: e.at,
    ...(e.chat === undefined
      ? {}
      : {
          chat: {
            nodeId: e.chat.nodeId,
            nativeId: e.chat.nativeId,
            title: e.chat.title,
            rootNativeId: room?.nativeId ?? e.chat.nativeId,
            rootTitle: room?.title ?? e.chat.title,
          },
        }),
    ...(e.actor?.id === undefined
      ? {}
      : {
          actor: {
            id: e.actor.id,
            ...(e.actor.name === undefined ? {} : { name: e.actor.name }),
            ...(e.actor.username === undefined ? {} : { username: e.actor.username }),
            ...(role === undefined ? {} : { role }),
            ...(e.actor.self ? { isSelf: true } : {}),
          },
        }),
    ...(text === undefined ? {} : { text }),
    ...(e.fields.message === undefined ? {} : { messageId: e.fields.message }),
    ...(e.fields.emoji === undefined ? {} : { emoji: e.fields.emoji }),
  }
}

function asChannelEvent(event: unknown): ScriptChannelEvent | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const e = event as Record<string, unknown>
  if (typeof e.type !== 'string' || !(CHANNEL_EVENT_TYPES as readonly string[]).includes(e.type))
    return undefined
  return {
    connectionId: '',
    eventId: 'synthetic',
    at: Date.now(),
    ...(e as object),
  } as ScriptChannelEvent
}

/** Run a version with every side effect recorded instead of done. */
export async function dryRunScript(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  input: DryRunInput,
): Promise<DryRunResult> {
  const s = getScript(deps, ref)
  const v = getVersion(deps, s.id, input.version)
  const manifest = versionManifest(v)
  let event: unknown
  let channel: ScriptChannelEvent | undefined
  if (input.eventId !== undefined && input.eventId !== '') {
    channel = await recordedEvent(deps, input.eventId, input.text)
    event = channel
  } else if (input.event !== undefined) {
    channel = asChannelEvent(input.event)
    event = channel ?? input.event
  } else event = { type: 'manual', at: deps.clock.now() }
  const triggers: string[] = []
  if (channel !== undefined)
    for (const t of manifest.triggers)
      if (t.kind === 'channel') triggers.push(channelMismatch(t, channel) ?? 'match')
  const run = await runner(deps).run({
    script: s,
    version: v,
    trigger: channel === undefined ? 'manual' : 'channel',
    event,
    dryRun: true,
    startedBy: actor.name,
  })
  return { run, triggers }
}

/** Run the active version now, for real (a person, or the agent the script belongs to). */
export async function runScriptNow(
  deps: Deps,
  actor: ScriptActor,
  ref: string,
  event?: unknown,
): Promise<ScriptRun> {
  const s = getScript(deps, ref)
  if (actor.kind === 'agent' && actor.agentId !== s.agentId)
    throw new DomainError(
      'forbidden',
      'FORBIDDEN',
      'Only the agent the script belongs to may run it',
    )
  if (s.status !== 'active' || s.activeVersion === null)
    throw conflict(
      `Script "${s.name}" is not active: activate it first (a dry run needs no activation)`,
      'NOT_ACTIVE',
    )
  if (deps.pause.get().pausedAt !== null)
    throw conflict('Everything is paused (Pause all): resume first', 'PAUSED')
  const v = getVersion(deps, s.id, s.activeVersion)
  const channel = asChannelEvent(event)
  return runner(deps).run({
    script: s,
    version: v,
    trigger: channel === undefined ? 'manual' : 'channel',
    event: channel ?? event ?? { type: 'manual', at: deps.clock.now() },
    dryRun: false,
    startedBy: actor.name,
  })
}

/** Retention: old runs go (the maintenance pass). */
export function pruneScriptRuns(deps: Deps): number {
  return deps.scripts.pruneRuns(
    deps.clock.now() - RUNS_KEEP_DAYS * 86_400_000,
    RUNS_KEEP_PER_SCRIPT,
  )
}
