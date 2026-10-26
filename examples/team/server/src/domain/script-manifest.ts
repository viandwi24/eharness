/**
 * What a script runs on and what it may touch (P59 W4–W5, ADR-0065): triggers, grants, limits, and
 * the pure checks the engine applies — trigger matching, the gates before a run, grant checks for
 * every `ctx` call, and whether a new version widens its grants (which needs a new approval).
 */
import { DEFAULT_SCRIPT_LIMITS, type ScriptLimits } from './scripts.ts'

// --- shapes ------------------------------------------------------------------------------------

export const CHANNEL_EVENT_TYPES = [
  'message.created',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'member.joined',
  'member.left',
  'member.updated',
  'member.join_requested',
  'member.join_request_resolved',
  'node.created',
  'node.updated',
  'node.state_changed',
  'node.migrated',
  'action',
] as const
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number]

export const TABLE_EVENT_TYPES = ['row.created', 'row.updated', 'row.deleted'] as const
export type TableEventType = (typeof TABLE_EVENT_TYPES)[number]

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type Role = (typeof ROLES)[number]

export interface ChannelTrigger {
  kind: 'channel'
  events: ChannelEventType[]
  /** Connection ids; empty = any connection of the script's agent. */
  connections: string[]
  /** Chats: a native id or a title (a chat includes its topics); empty = any chat. */
  chats: string[]
  /** The directory role of the person behind the event; empty = anybody. */
  actorRoles: Role[]
  /** The person: a platform user id, `@username` or exact name; empty = anybody. */
  actors: string[]
  /** Message events: the text has any of these words (ignoring case). */
  textContains: string[]
  /** Message events: the text matches this expression (case-insensitive, bounded). */
  textRegex?: string
}

export interface ScheduleTrigger {
  kind: 'schedule'
  /** A routine schedule: `{ kind: 'cron', expr, timezone? }`, `{ kind: 'every', everyMs }`, `{ kind: 'at', at }`. */
  spec: Record<string, unknown>
}

export interface TableTrigger {
  kind: 'table'
  table: string
  events: TableEventType[]
}

/**
 * App events a script may start on: what the team app itself does (tasks, programs, routines,
 * decisions, alarms, files, agents, settings…). Noisy or self-referencing types are left out.
 */
export const APP_TRIGGER_TYPES = [
  'message-added',
  'task-changed',
  'agent-message',
  'file-changed',
  'agent-changed',
  'routine-fired',
  'routine-changed',
  'program-changed',
  'decision-changed',
  'heartbeat-changed',
  'settings-changed',
  'providers-changed',
  'connectors-changed',
  'thread-changed',
  'notification-changed',
  'alarm-raised',
  'turn-started',
  'pending-changed',
  'approval-decided',
  'attention-answered',
  'child-reported',
] as const
export type AppTriggerType = (typeof APP_TRIGGER_TYPES)[number]

export interface AppTrigger {
  kind: 'app'
  events: AppTriggerType[]
  /** Only events of these agents (id or slug); empty = any. */
  agents: string[]
  /** Payload fields that must equal these values (text compare, e.g. { "change": "done" }). */
  match: Record<string, string>
}

/** A POST to the script's webhook URL (a secret link) starts it with the request as the event. */
export interface WebhookTrigger {
  kind: 'webhook'
}

export type ScriptTrigger =
  | ChannelTrigger
  | ScheduleTrigger
  | TableTrigger
  | AppTrigger
  | WebhookTrigger

/** A chat a script may post to. */
export interface ChatGrant {
  connection: string
  /** A native id, node id or title. */
  chat: string
  topic?: string
}

export interface ScriptGrants {
  /** Chats `ctx.channels.send` may post to. */
  send: ChatGrant[]
  /** `ctx.channels.reply` may answer in the chat of the channel event that started the run. */
  reply: boolean
  /** Library path globs (`/library/reports/**`): read, and write (also readable). */
  libraryRead: string[]
  libraryWrite: string[]
  /** Table names (`*` = any): read, and write (also readable). */
  tablesRead: string[]
  tablesWrite: string[]
  /** Hosts `ctx.http.fetch` may call (`api.example.com`, `*.example.com`); https only. */
  http: string[]
  /** Agents (slug or id) `ctx.agent.wake` may wake (a paid model turn). */
  wake: string[]
  /** Programs (name or id) `ctx.programs.run` may start. */
  programs: string[]
  /**
   * Routes of the team API `ctx.api` may call: `METHOD /path` with globs (`GET /tasks/**`,
   * `* /tables/orders/**`; `*` is one path segment). Some routes are never callable (`API_DENIED`).
   */
  api: string[]
}

export interface ScriptManifest {
  triggers: ScriptTrigger[]
  grants: ScriptGrants
  /** After a run, the next one waits this long (seconds; 0 = none). Skipped events are logged. */
  cooldownSec: number
  /** Most runs started in one hour (0 = no cap). */
  maxRunsPerHour: number
  /** Overrides of the default limits, bounded by `LIMIT_BOUNDS`. */
  limits: Partial<ScriptLimits>
}

export const emptyGrants = (): ScriptGrants => ({
  send: [],
  reply: false,
  libraryRead: [],
  libraryWrite: [],
  tablesRead: [],
  tablesWrite: [],
  http: [],
  wake: [],
  programs: [],
  api: [],
})

/** The most a script may ask for. */
export const LIMIT_BOUNDS: Record<keyof ScriptLimits, [number, number]> = {
  memoryMb: [8, 256],
  cpuMs: [100, 60_000],
  wallMs: [1_000, 300_000],
  maxHostCalls: [1, 2_000],
  maxLogLines: [10, 2_000],
  maxLogChars: [1_000, 200_000],
  maxValueChars: [1_000, 1_000_000],
}

export const MAX_TRIGGERS = 10
export const MAX_LIST = 50
export const MAX_ITEM = 200
export const MAX_REGEX = 200
/** The text a regex or a contains filter looks at is cut to this. */
export const MAX_TEXT_SCAN = 2000
export const REGEX_BUDGET_MS = 25
/** Events older than this are not run after a restart (a catch-up replays old ones). */
export const FRESH_MS = 15 * 60_000
/** A script failing this many runs in a row is switched off and an alarm is raised. */
export const MAX_CONSECUTIVE_FAILURES = 5

// --- parsing -----------------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const strings = (v: unknown, what: string, errors: string[]): string[] => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    errors.push(`${what} must be a list`)
    return []
  }
  if (v.length > MAX_LIST) errors.push(`${what}: at most ${MAX_LIST} entries`)
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > MAX_ITEM) {
      errors.push(`${what}: entries are non-empty text of at most ${MAX_ITEM} characters`)
      continue
    }
    out.push(item.trim())
  }
  return out
}

function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  what: string,
  errors: string[],
): T[] {
  const list = strings(v, what, errors)
  const out: T[] = []
  for (const x of list) {
    if ((allowed as readonly string[]).includes(x)) out.push(x as T)
    else errors.push(`${what}: "${x}" is not one of ${allowed.join(', ')}`)
  }
  return out
}

/** A manifest from untrusted input (the web, the agent tool), or the problems as sentences. */
export function parseManifest(input: unknown): Result<ScriptManifest> {
  const errors: string[] = []
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const triggers: ScriptTrigger[] = []
  const rawTriggers = raw.triggers ?? []
  if (!Array.isArray(rawTriggers)) errors.push('triggers must be a list')
  else {
    if (rawTriggers.length > MAX_TRIGGERS) errors.push(`at most ${MAX_TRIGGERS} triggers`)
    rawTriggers.forEach((t, i) => {
      const where = `trigger ${i + 1}`
      if (typeof t !== 'object' || t === null) {
        errors.push(`${where} must be an object`)
        return
      }
      const r = t as Record<string, unknown>
      if (r.kind === 'channel') {
        const events = oneOf(r.events, CHANNEL_EVENT_TYPES, `${where} events`, errors)
        if (events.length === 0) errors.push(`${where}: name at least one event type`)
        const trig: ChannelTrigger = {
          kind: 'channel',
          events,
          connections: strings(r.connections, `${where} connections`, errors),
          chats: strings(r.chats, `${where} chats`, errors),
          actorRoles: oneOf(r.actorRoles, ROLES, `${where} actorRoles`, errors),
          actors: strings(r.actors, `${where} actors`, errors),
          textContains: strings(r.textContains, `${where} textContains`, errors),
        }
        if (typeof r.textRegex === 'string' && r.textRegex !== '') {
          const bad = regexProblem(r.textRegex)
          if (bad !== undefined) errors.push(`${where} textRegex: ${bad}`)
          else trig.textRegex = r.textRegex
        }
        triggers.push(trig)
      } else if (r.kind === 'schedule') {
        if (typeof r.spec !== 'object' || r.spec === null)
          errors.push(
            `${where}: spec is { kind: "cron", expr, timezone? } | { kind: "every", everyMs } | { kind: "at", at }`,
          )
        else triggers.push({ kind: 'schedule', spec: r.spec as Record<string, unknown> })
      } else if (r.kind === 'table') {
        const table = typeof r.table === 'string' ? r.table.trim() : ''
        if (table === '') errors.push(`${where}: table is needed`)
        const events = oneOf(r.events, TABLE_EVENT_TYPES, `${where} events`, errors)
        if (events.length === 0)
          errors.push(`${where}: name at least one of ${TABLE_EVENT_TYPES.join(', ')}`)
        triggers.push({ kind: 'table', table, events })
      } else if (r.kind === 'app') {
        const events = oneOf(r.events, APP_TRIGGER_TYPES, `${where} events`, errors)
        if (events.length === 0) errors.push(`${where}: name at least one app event`)
        const match: Record<string, string> = {}
        const rawMatch = r.match ?? {}
        if (typeof rawMatch !== 'object' || rawMatch === null || Array.isArray(rawMatch))
          errors.push(`${where} match must be an object of field: value`)
        else
          for (const [k, v] of Object.entries(rawMatch)) {
            if (Object.keys(match).length >= 10) {
              errors.push(`${where} match: at most 10 fields`)
              break
            }
            if (
              !/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(k) ||
              (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
            )
              errors.push(`${where} match: "${k}" needs a text, number or true/false value`)
            else match[k] = String(v)
          }
        triggers.push({
          kind: 'app',
          events,
          agents: strings(r.agents, `${where} agents`, errors),
          match,
        })
      } else if (r.kind === 'webhook') {
        triggers.push({ kind: 'webhook' })
      } else errors.push(`${where}: kind is channel, schedule, table, app or webhook`)
    })
  }
  if (triggers.filter((t) => t.kind === 'schedule').length > 1)
    errors.push('at most one schedule trigger')
  if (triggers.filter((t) => t.kind === 'webhook').length > 1)
    errors.push('at most one webhook trigger')

  const g = (typeof raw.grants === 'object' && raw.grants !== null ? raw.grants : {}) as Record<
    string,
    unknown
  >
  const send: ChatGrant[] = []
  const rawSend = g.send ?? []
  if (!Array.isArray(rawSend))
    errors.push('grants.send must be a list of { connection, chat, topic? }')
  else
    for (const [i, s] of rawSend.entries()) {
      const r = (s ?? {}) as Record<string, unknown>
      if (
        typeof r.connection !== 'string' ||
        r.connection === '' ||
        typeof r.chat !== 'string' ||
        r.chat === ''
      ) {
        errors.push(`grants.send ${i + 1}: { connection, chat } are needed`)
        continue
      }
      send.push({
        connection: r.connection,
        chat: r.chat,
        ...(typeof r.topic === 'string' && r.topic !== '' ? { topic: r.topic } : {}),
      })
    }
  const paths = (v: unknown, what: string): string[] => {
    const list = strings(v, what, errors)
    for (const p of list)
      if (!p.startsWith('/'))
        errors.push(`${what}: "${p}" must start with / (e.g. /library/reports/**)`)
    return list
  }
  const grants: ScriptGrants = {
    send,
    reply: g.reply === true,
    libraryRead: paths(g.libraryRead, 'grants.libraryRead'),
    libraryWrite: paths(g.libraryWrite, 'grants.libraryWrite'),
    tablesRead: strings(g.tablesRead, 'grants.tablesRead', errors),
    tablesWrite: strings(g.tablesWrite, 'grants.tablesWrite', errors),
    http: strings(g.http, 'grants.http', errors).map((h) => h.toLowerCase()),
    wake: strings(g.wake, 'grants.wake', errors),
    programs: strings(g.programs, 'grants.programs', errors),
    api: strings(g.api, 'grants.api', errors).map((x) => x.replace(/\s+/g, ' ')),
  }
  for (const a of grants.api) {
    const bad = apiGrantProblem(a)
    if (bad !== undefined) errors.push(`grants.api: ${bad}`)
  }
  for (const h of grants.http)
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h))
      errors.push(`grants.http: "${h}" is not a host name`)

  const num = (v: unknown, what: string, min: number, max: number, dflt: number): number => {
    if (v === undefined || v === null) return dflt
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${what} must be a whole number from ${min} to ${max}`)
      return dflt
    }
    return v
  }
  const limits: Partial<ScriptLimits> = {}
  const rawLimits = (
    typeof raw.limits === 'object' && raw.limits !== null ? raw.limits : {}
  ) as Record<string, unknown>
  for (const [key, value] of Object.entries(rawLimits)) {
    const bounds = LIMIT_BOUNDS[key as keyof ScriptLimits]
    if (bounds === undefined) {
      errors.push(`limits.${key} is not a limit (${Object.keys(LIMIT_BOUNDS).join(', ')})`)
      continue
    }
    limits[key as keyof ScriptLimits] = num(
      value,
      `limits.${key}`,
      bounds[0],
      bounds[1],
      DEFAULT_SCRIPT_LIMITS[key as keyof ScriptLimits],
    )
  }
  const manifest: ScriptManifest = {
    triggers,
    grants,
    cooldownSec: num(raw.cooldownSec, 'cooldownSec', 0, 7 * 86_400, 0),
    maxRunsPerHour: num(raw.maxRunsPerHour, 'maxRunsPerHour', 0, 10_000, 60),
    limits,
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: manifest }
}

// --- grants ------------------------------------------------------------------------------------

/** `**` matches any depth, `*` anything inside one path segment. */
export function globMatch(glob: string, path: string): boolean {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${re}$`).test(path)
}

export const canReadPath = (g: ScriptGrants, path: string): boolean =>
  [...g.libraryRead, ...g.libraryWrite].some((glob) => globMatch(glob, path))
export const canWritePath = (g: ScriptGrants, path: string): boolean =>
  g.libraryWrite.some((glob) => globMatch(glob, path))
export const canReadTable = (g: ScriptGrants, table: string): boolean =>
  [...g.tablesRead, ...g.tablesWrite].some((t) => t === '*' || t === table)
export const canWriteTable = (g: ScriptGrants, table: string): boolean =>
  g.tablesWrite.some((t) => t === '*' || t === table)

export function canFetchHost(g: ScriptGrants, host: string): boolean {
  const h = host.toLowerCase()
  return g.http.some((allowed) =>
    allowed.startsWith('*.') ? h.endsWith(allowed.slice(1)) : h === allowed,
  )
}

// --- app events ----------------------------------------------------------------------------------

/** An app event as the scripts engine sees it. */
export interface ScriptAppEvent {
  type: string
  seq?: number
  at: number
  agentId?: string
  agentSlug?: string
  sessionId?: string
  payload: Record<string, unknown>
}

/** Why an app trigger does not match an event, or undefined when it does. */
export function appMismatch(t: AppTrigger, e: ScriptAppEvent): string | undefined {
  if (!(t.events as readonly string[]).includes(e.type)) return 'another event type'
  if (t.agents.length > 0 && !t.agents.some((a) => a === e.agentId || a === e.agentSlug))
    return 'another agent'
  for (const [k, want] of Object.entries(t.match)) {
    let v: unknown = e.payload
    for (const part of k.split('.'))
      v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[part] : undefined
    if (v === undefined || v === null || String(v) !== want) return `${k} is not ${want}`
  }
  return undefined
}

// --- the team API ------------------------------------------------------------------------------

/**
 * Routes no script may call whatever its grants say: scripts themselves (a script must not approve
 * or rewrite itself), credentials and secrets, sign-in, restores and the developer keys.
 */
export const API_DENIED = [
  '/scripts/**',
  '/scripts-types',
  '/auth/**',
  '/login/**',
  '/providers/**',
  '/connectors/**',
  '/backups/**',
  '/storage/**',
  '/developer/**',
  '/workspace/**',
  '/v1/**',
  '/hooks/**',
] as const

/** Why an API grant is not usable, or undefined. */
export function apiGrantProblem(grant: string): string | undefined {
  if (!/^(\*|GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(grant))
    return `"${grant.slice(0, 80)}" is "METHOD /path" (GET, POST, PUT, PATCH, DELETE or *; globs in the path)`
  return undefined
}

/** The path of a call without its query, or undefined when it is not a clean absolute path. */
export function apiPath(path: string): string | undefined {
  const p = path.split('?')[0] ?? ''
  if (!p.startsWith('/') || p.includes('..') || p.includes('//') || p.includes('\\'))
    return undefined
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

export const apiDenied = (path: string): boolean =>
  API_DENIED.some(
    (g) => globMatch(g, path) || globMatch(g, `${path}/`) || path === g.replace('/**', ''),
  )

export function canCallApi(g: ScriptGrants, method: string, path: string): boolean {
  const m = method.toUpperCase()
  return g.api.some((grant) => {
    const [gm, gp] = grant.split(' ') as [string, string]
    return (gm === '*' || gm === m) && globMatch(gp, path)
  })
}

const sameChat = (a: ChatGrant, b: ChatGrant): boolean =>
  a.connection === b.connection &&
  a.chat.toLowerCase() === b.chat.toLowerCase() &&
  (a.topic ?? '') === (b.topic ?? '')

/**
 * What a new manifest may do that the old one could not, as sentences (empty = no widening).
 * An active script whose new version widens its grants runs the old version until approved.
 */
export function grantWidening(before: ScriptGrants | undefined, after: ScriptGrants): string[] {
  const b = before ?? emptyGrants()
  const out: string[] = []
  for (const s of after.send)
    if (!b.send.some((x) => sameChat(x, s)))
      out.push(`post to ${s.chat}${s.topic ? ` / ${s.topic}` : ''} on ${s.connection}`)
  if (after.reply && !b.reply) out.push('reply in the chat of the event')
  const newer = (list: string[], old: string[], what: string): void => {
    for (const x of list) if (!old.includes(x)) out.push(`${what} ${x}`)
  }
  newer(after.libraryRead, [...b.libraryRead, ...b.libraryWrite], 'read')
  newer(after.libraryWrite, b.libraryWrite, 'write')
  const oldRead = [...b.tablesRead, ...b.tablesWrite]
  for (const t of after.tablesRead)
    if (!oldRead.includes(t) && !oldRead.includes('*')) out.push(`read table ${t}`)
  for (const t of after.tablesWrite)
    if (!b.tablesWrite.includes(t) && !b.tablesWrite.includes('*')) out.push(`write table ${t}`)
  newer(after.http, b.http, 'call')
  newer(after.wake, b.wake, 'wake agent')
  newer(after.programs, b.programs, 'run program')
  newer(after.api, b.api, 'call the API')
  return out
}

// --- regex -------------------------------------------------------------------------------------

/** Shapes that make a backtracking engine take exponential time. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/
const BACKREFERENCE = /\\[1-9]|\\k</
const WIDE_REPEAT = /\{\d{3,}|\{\d+,\d{3,}/

export function regexProblem(pattern: string): string | undefined {
  if (pattern === '') return 'the expression is empty'
  if (pattern.length > MAX_REGEX) return `the expression is longer than ${MAX_REGEX} characters`
  if (NESTED_QUANTIFIER.test(pattern))
    return 'a repeated group inside a repeated group (like (a+)+) can run for ever: simplify it'
  if (BACKREFERENCE.test(pattern)) return 'back references are not allowed'
  if (WIDE_REPEAT.test(pattern)) return 'a repeat count of 100 or more is not allowed'
  try {
    new RegExp(pattern, 'iu')
  } catch (error) {
    return `not a valid expression: ${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}

// --- matching ----------------------------------------------------------------------------------

/** A channel event as the scripts engine sees it (the text is in memory only, never stored). */
export interface ScriptChannelEvent {
  type: ChannelEventType
  connectionId: string
  eventId: string
  at: number
  chat?: {
    nodeId: string
    nativeId: string
    title: string | null
    rootNativeId: string
    rootTitle: string | null
  }
  actor?: { id: string; name?: string; username?: string; role?: Role; isSelf?: boolean }
  text?: string
  messageId?: string
  /** A reply: the platform id of the message it answers (and, when the platform says, its sender). */
  replyTo?: { messageId: string; senderId?: string; senderName?: string }
  emoji?: string
}

/** Why a channel trigger does not match an event, or undefined when it does. */
export function channelMismatch(t: ChannelTrigger, e: ScriptChannelEvent): string | undefined {
  if (!t.events.includes(e.type)) return 'another event type'
  if (t.connections.length > 0 && !t.connections.includes(e.connectionId))
    return 'another connection'
  if (t.chats.length > 0) {
    const c = e.chat
    const names =
      c === undefined ? [] : [c.nativeId, c.title, c.rootNativeId, c.rootTitle, c.nodeId]
    const hit = t.chats.some((want) =>
      names.some((n) => n !== null && n !== undefined && n.toLowerCase() === want.toLowerCase()),
    )
    if (!hit) return 'another chat'
  }
  if (
    t.actorRoles.length > 0 &&
    (e.actor?.role === undefined || !t.actorRoles.includes(e.actor.role))
  )
    return 'another role'
  if (t.actors.length > 0) {
    const a = e.actor
    const who =
      a === undefined ? [] : [a.id, a.name, a.username === undefined ? undefined : `@${a.username}`]
    if (
      !t.actors.some((x) => who.some((w) => w !== undefined && w.toLowerCase() === x.toLowerCase()))
    )
      return 'another person'
  }
  if (t.textContains.length > 0 || t.textRegex !== undefined) {
    const text = (e.text ?? '').slice(0, MAX_TEXT_SCAN)
    if (
      t.textContains.length > 0 &&
      !t.textContains.some((w) => text.toLowerCase().includes(w.toLowerCase()))
    )
      return 'the text has none of the words'
    if (t.textRegex !== undefined) {
      const started = performance.now()
      let hit = false
      try {
        hit = new RegExp(t.textRegex, 'iu').test(text)
      } catch {
        return 'the expression failed'
      }
      if (performance.now() - started > REGEX_BUDGET_MS) return 'the expression is too slow'
      if (!hit) return 'the text does not match the expression'
    }
  }
  return undefined
}

// --- gates -------------------------------------------------------------------------------------

export type SkipReason = 'paused' | 'cooldown' | 'cap' | 'loop' | 'stale' | 'disabled'

export interface GateState {
  now: number
  paused: boolean
  /** The start of the script's last run (real, not dry), or null. */
  lastRunAt: number | null
  /** Runs started in the last hour. */
  runsLastHour: number
  /** When the event happened (null for a schedule or manual run). */
  eventAt: number | null
  /** The event was caused by this script, or by the agent itself. */
  selfCaused: boolean
}

/** Why an automatic run must not start, or undefined. Manual and dry runs skip the gates. */
export function gateOf(m: ScriptManifest, s: GateState): SkipReason | undefined {
  if (s.paused) return 'paused'
  if (s.selfCaused) return 'loop'
  if (s.eventAt !== null && s.now - s.eventAt > FRESH_MS) return 'stale'
  if (m.cooldownSec > 0 && s.lastRunAt !== null && s.now - s.lastRunAt < m.cooldownSec * 1000)
    return 'cooldown'
  if (m.maxRunsPerHour > 0 && s.runsLastHour >= m.maxRunsPerHour) return 'cap'
  return undefined
}

export const SKIP_TEXT: Record<SkipReason, string> = {
  paused: 'Pause all is on, so nothing automatic runs',
  cooldown: 'the script ran a moment ago and is cooling down',
  cap: 'the script reached its runs per hour',
  loop: 'the event was caused by this script or by the agent itself (this avoids loops)',
  stale: 'the event is too old (seen again after a restart)',
  disabled: 'the script is not active',
}

// --- JSON Schema (editor help) -------------------------------------------------------------

const list = (items: Record<string, unknown>, description: string): Record<string, unknown> => ({
  type: 'array',
  items,
  maxItems: MAX_LIST,
  description,
})
const text = { type: 'string', minLength: 1, maxLength: MAX_ITEM }

/**
 * A JSON Schema of the manifest for editors (autocomplete, hover docs, inline errors). It mirrors
 * `parseManifest`, which stays the authority: the server checks every save.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  const limitProps: Record<string, unknown> = {}
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS))
    limitProps[key] = {
      type: 'integer',
      minimum: min,
      maximum: max,
      description: `Default ${DEFAULT_SCRIPT_LIMITS[key as keyof ScriptLimits]}.`,
    }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Script manifest',
    type: 'object',
    additionalProperties: false,
    properties: {
      triggers: {
        type: 'array',
        maxItems: MAX_TRIGGERS,
        description:
          'What starts the script. Any trigger starts it; all filters of one trigger must match. None = by hand only.',
        items: {
          type: 'object',
          required: ['kind'],
          oneOf: [
            {
              properties: {
                kind: { const: 'channel', description: 'A chat event.' },
                events: list({ enum: [...CHANNEL_EVENT_TYPES] }, 'Event types (at least one).'),
                connections: list(text, 'Connection ids (Channels page). Empty = any.'),
                chats: list(text, 'Chat title, platform id (-100…) or node id. Empty = any.'),
                actorRoles: list({ enum: [...ROLES] }, 'Only events by people with these roles.'),
                actors: list(text, 'Only events by these people: platform id, name or @username.'),
                textContains: list(text, 'The text has any of these words (ignoring case).'),
                textRegex: {
                  type: 'string',
                  maxLength: MAX_REGEX,
                  description:
                    'A bounded regular expression (no nested repeats, no back references).',
                },
              },
              required: ['kind', 'events'],
              additionalProperties: false,
            },
            {
              properties: {
                kind: { const: 'schedule', description: 'A schedule.' },
                spec: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        kind: { const: 'cron' },
                        expr: {
                          type: 'string',
                          description: 'Cron: minute hour day month weekday ("0 9 * * *").',
                        },
                        timezone: {
                          type: 'string',
                          description: 'IANA timezone; default the team timezone.',
                        },
                      },
                      required: ['kind', 'expr'],
                      additionalProperties: false,
                    },
                    {
                      type: 'object',
                      properties: {
                        kind: { const: 'every' },
                        everyMs: {
                          type: 'integer',
                          minimum: 60_000,
                          description: 'Interval in ms (at least one minute).',
                        },
                      },
                      required: ['kind', 'everyMs'],
                      additionalProperties: false,
                    },
                    {
                      type: 'object',
                      properties: {
                        kind: { const: 'at' },
                        at: {
                          type: ['string', 'integer'],
                          description: 'Once: an ISO date or epoch ms.',
                        },
                      },
                      required: ['kind', 'at'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ['kind', 'spec'],
              additionalProperties: false,
            },
            {
              properties: {
                kind: {
                  const: 'app',
                  description:
                    'Something the team app did (a task, program, alarm, decision, file…).',
                },
                events: list({ enum: [...APP_TRIGGER_TYPES] }, 'App event types (at least one).'),
                agents: list(text, 'Only events of these agents (id or slug). Empty = any.'),
                match: {
                  type: 'object',
                  additionalProperties: { type: ['string', 'number', 'boolean'] },
                  description:
                    'Payload fields that must equal these values, e.g. { "change": "done" }.',
                },
              },
              required: ['kind', 'events'],
              additionalProperties: false,
            },
            {
              properties: {
                kind: {
                  const: 'webhook',
                  description: 'A POST to the secret webhook URL of the script.',
                },
              },
              required: ['kind'],
              additionalProperties: false,
            },
            {
              properties: {
                kind: { const: 'table', description: 'A change in a table.' },
                table: { type: 'string', description: 'Table name.' },
                events: list({ enum: [...TABLE_EVENT_TYPES] }, 'Row events (at least one).'),
              },
              required: ['kind', 'table', 'events'],
              additionalProperties: false,
            },
          ],
        },
      },
      grants: {
        type: 'object',
        additionalProperties: false,
        description: 'What the script may touch. Default: nothing.',
        properties: {
          send: list(
            {
              type: 'object',
              properties: { connection: text, chat: text, topic: text },
              required: ['connection', 'chat'],
              additionalProperties: false,
            },
            'Chats ctx.channels.send may post to.',
          ),
          reply: {
            type: 'boolean',
            description: 'ctx.channels.reply may answer in the chat of the event.',
          },
          libraryRead: list(
            { type: 'string', pattern: '^/' },
            'Library paths to read (globs: /library/reports/**).',
          ),
          libraryWrite: list(
            { type: 'string', pattern: '^/' },
            'Library paths to write (also readable).',
          ),
          tablesRead: list(text, 'Tables to read (* = any).'),
          tablesWrite: list(text, 'Tables to change (also readable; * = any).'),
          http: list(
            { type: 'string' },
            'Hosts for ctx.http (api.example.com, *.example.com); https only.',
          ),
          wake: list(text, 'Agents (slug or name) ctx.agent.wake may wake (a paid model turn).'),
          programs: list(text, 'Programs (name or id) ctx.programs.run may start.'),
          api: list(
            { type: 'string', pattern: '^(\\*|GET|POST|PUT|PATCH|DELETE) /' },
            'Team API routes ctx.api may call: "GET /tasks/**", "POST /tables/orders/rows". Scripts, secrets, sign-in and backups are never callable.',
          ),
        },
      },
      cooldownSec: {
        type: 'integer',
        minimum: 0,
        maximum: 7 * 86_400,
        description: 'After a run, skip events for this many seconds.',
      },
      maxRunsPerHour: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000,
        description: 'Most runs in one hour (default 60; 0 = no cap).',
      },
      limits: {
        type: 'object',
        additionalProperties: false,
        properties: limitProps,
        description: 'Overrides of the default limits.',
      },
    },
  }
}
