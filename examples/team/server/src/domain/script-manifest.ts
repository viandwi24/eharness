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

export type ScriptTrigger = ChannelTrigger | ScheduleTrigger | TableTrigger

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
      } else errors.push(`${where}: kind is channel, schedule or table`)
    })
  }
  if (triggers.filter((t) => t.kind === 'schedule').length > 1)
    errors.push('at most one schedule trigger')

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
