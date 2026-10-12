/**
 * Reminders created from a chat (docs/plans/P41-team-channels.md, phase L6): the data (`ch_reminders`)
 * and the reading of "when" in the team timezone. The schedule itself is a `sys:reminder:<id>`
 * routine (claim, restart safety, catch-up after downtime, shared with the heartbeat); a fire posts
 * the fixed text through the outbox without a model call (`gateway.reminders.fire`). Pure helpers
 * and a SQLite store; no gateway here.
 */
import type { Database } from 'bun:sqlite'
import type { RoutineSpec } from '../../domain/routines.ts'
import { localTime } from './header.ts'
import { likePattern, orderBy, windowOf } from './paging.ts'
import { parseClock, parseLocalDateTime, wallOf } from './time.ts'

/** The `connectionId` of a reminder that is delivered into a web chat thread (no channel connection). */
export const WEB_REMINDER_CONNECTION = 'web'
const WEB_NODE_PREFIX = 'thread:'
/** The `nodeId` of a reminder for the thread (session) it was created in. */
export const webReminderNode = (sessionId: string): string => `${WEB_NODE_PREFIX}${sessionId}`
/** The session id of a web reminder row, or undefined for a channel reminder. */
export const webReminderSession = (r: {
  connectionId: string
  nodeId: string
}): string | undefined =>
  r.connectionId === WEB_REMINDER_CONNECTION && r.nodeId.startsWith(WEB_NODE_PREFIX)
    ? r.nodeId.slice(WEB_NODE_PREFIX.length)
    : undefined

export type ReminderStatus = 'active' | 'done' | 'cancelled'

export interface ReminderRow {
  id: string
  connectionId: string
  nodeId: string
  agentId: string
  routineId: string | null
  body: string
  /** Identity ids (ours) to mention. */
  mentions: string[]
  schedule: RoutineSpec
  /** The schedule in words, with the absolute time and zone: what the confirmation echoes. */
  whenText: string
  timezone: string
  status: ReminderStatus
  createdByIdentityId: string | null
  createdByName: string | null
  createdByRole: string | null
  createdAt: number
  lastFiredAt: number | null
  fireCount: number
  lastError: string | null
}

interface ReminderDb {
  id: string
  connection_id: string
  node_id: string
  agent_id: string
  routine_id: string | null
  body: string
  mentions: string
  schedule: string
  when_text: string
  timezone: string
  status: string
  created_by_identity_id: string | null
  created_by_name: string | null
  created_by_role: string | null
  created_at: number
  last_fired_at: number | null
  fire_count: number
  last_error: string | null
}

const toRow = (r: ReminderDb): ReminderRow => ({
  id: r.id,
  connectionId: r.connection_id,
  nodeId: r.node_id,
  agentId: r.agent_id,
  routineId: r.routine_id,
  body: r.body,
  mentions: JSON.parse(r.mentions) as string[],
  schedule: JSON.parse(r.schedule) as RoutineSpec,
  whenText: r.when_text,
  timezone: r.timezone,
  status: r.status as ReminderStatus,
  createdByIdentityId: r.created_by_identity_id,
  createdByName: r.created_by_name,
  createdByRole: r.created_by_role,
  createdAt: r.created_at,
  lastFiredAt: r.last_fired_at,
  fireCount: r.fire_count,
  lastError: r.last_error,
})

export interface NewReminder {
  id: string
  connectionId: string
  nodeId: string
  agentId: string
  routineId: string | null
  body: string
  mentions: string[]
  schedule: RoutineSpec
  whenText: string
  timezone: string
  createdByIdentityId?: string | undefined
  createdByName?: string | undefined
  createdByRole?: string | undefined
  createdAt: number
}

export interface ReminderStore {
  insert(r: NewReminder): ReminderRow
  get(id: string): ReminderRow | undefined
  list(
    connectionId: string,
    filter?: { status?: ReminderStatus; nodeIds?: readonly string[]; createdBy?: string },
  ): ReminderRow[]
  /** One page of the reminders of a connection, filtered, sorted and counted in SQL. */
  table(
    connectionId: string,
    query: {
      q?: string | undefined
      sort?: string | undefined
      order?: 'asc' | 'desc' | undefined
      status?: ReminderStatus | undefined
      nodeId?: string | undefined
      page: number
      limit: number
    },
  ): { items: ReminderRow[]; total: number }
  update(
    id: string,
    patch: Partial<
      Pick<
        ReminderRow,
        | 'body'
        | 'mentions'
        | 'schedule'
        | 'whenText'
        | 'timezone'
        | 'status'
        | 'nodeId'
        | 'lastFiredAt'
        | 'lastError'
        | 'routineId'
      >
    > & { fired?: boolean },
  ): ReminderRow | undefined
  /** Delete finished reminders (done or cancelled) older than `before`; returns their routine ids. */
  purge(before: number): string[]
  clear(connectionId: string): void
}

export function sqliteReminderStore(sqlite: Database): ReminderStore {
  const getQ = sqlite.query<ReminderDb, [string]>('SELECT * FROM ch_reminders WHERE id = ?')
  const get = (id: string): ReminderRow | undefined => {
    const r = getQ.get(id)
    return r === null ? undefined : toRow(r)
  }
  return {
    get,
    insert(r) {
      sqlite
        .query(
          `INSERT INTO ch_reminders (id, connection_id, node_id, agent_id, routine_id, body, mentions, schedule,
             when_text, timezone, status, created_by_identity_id, created_by_name, created_by_role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.connectionId,
          r.nodeId,
          r.agentId,
          r.routineId,
          r.body,
          JSON.stringify(r.mentions),
          JSON.stringify(r.schedule),
          r.whenText,
          r.timezone,
          r.createdByIdentityId ?? null,
          r.createdByName ?? null,
          r.createdByRole ?? null,
          r.createdAt,
        )
      return get(r.id) as ReminderRow
    },
    list(connectionId, filter) {
      const rows = sqlite
        .query<ReminderDb, [string]>(
          'SELECT * FROM ch_reminders WHERE connection_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(connectionId)
        .map(toRow)
      return rows.filter(
        (r) =>
          (filter?.status === undefined || r.status === filter.status) &&
          (filter?.nodeIds === undefined || filter.nodeIds.includes(r.nodeId)) &&
          (filter?.createdBy === undefined || r.createdByIdentityId === filter.createdBy),
      )
    },
    table(connectionId, q) {
      const where = ['connection_id = ?']
      const args: Array<string | number> = [connectionId]
      if (q.status !== undefined) {
        where.push('status = ?')
        args.push(q.status)
      }
      if (q.nodeId !== undefined) {
        where.push('node_id = ?')
        args.push(q.nodeId)
      }
      if (q.q !== undefined && q.q.trim() !== '') {
        const like = likePattern(q.q.trim())
        where.push(
          `(body LIKE ? ESCAPE '\\' OR when_text LIKE ? ESCAPE '\\' OR created_by_name LIKE ? ESCAPE '\\')`,
        )
        args.push(like, like, like)
      }
      const from = `FROM ch_reminders WHERE ${where.join(' AND ')}`
      const order = orderBy(
        {
          createdAt: { expr: 'created_at', defaultOrder: 'desc' },
          lastFiredAt: { expr: 'COALESCE(last_fired_at, 0)', defaultOrder: 'desc' },
          status: { expr: 'status', defaultOrder: 'asc' },
          fireCount: { expr: 'fire_count', defaultOrder: 'desc' },
          text: { expr: 'body COLLATE NOCASE', defaultOrder: 'asc' },
        },
        q.sort,
        q.order,
        'createdAt',
        'id',
      )
      const total =
        sqlite
          .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n ${from}`)
          .get(...args)?.n ?? 0
      const rows = sqlite
        .query<ReminderDb, Array<string | number>>(`SELECT * ${from} ${order} LIMIT ? OFFSET ?`)
        .all(...args, ...windowOf(q.page, q.limit))
      return { items: rows.map(toRow), total }
    },
    update(id, patch) {
      const sets: string[] = []
      const args: Array<string | number | null> = []
      const set = (col: string, value: string | number | null): void => {
        sets.push(`${col} = ?`)
        args.push(value)
      }
      if (patch.body !== undefined) set('body', patch.body)
      if (patch.mentions !== undefined) set('mentions', JSON.stringify(patch.mentions))
      if (patch.schedule !== undefined) set('schedule', JSON.stringify(patch.schedule))
      if (patch.whenText !== undefined) set('when_text', patch.whenText)
      if (patch.timezone !== undefined) set('timezone', patch.timezone)
      if (patch.status !== undefined) set('status', patch.status)
      if (patch.nodeId !== undefined) set('node_id', patch.nodeId)
      if (patch.lastFiredAt !== undefined) set('last_fired_at', patch.lastFiredAt)
      if (patch.lastError !== undefined) set('last_error', patch.lastError)
      if (patch.routineId !== undefined) set('routine_id', patch.routineId)
      if (patch.fired === true) sets.push('fire_count = fire_count + 1')
      if (sets.length === 0) return get(id)
      sqlite
        .query(`UPDATE ch_reminders SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(args as never[]), id)
      return get(id)
    },
    purge(before) {
      const rows = sqlite
        .query<{ id: string; routine_id: string | null }, [number]>(
          `SELECT id, routine_id FROM ch_reminders WHERE status != 'active' AND COALESCE(last_fired_at, created_at) < ?`,
        )
        .all(before)
      for (const r of rows) sqlite.query('DELETE FROM ch_reminders WHERE id = ?').run(r.id)
      return rows.flatMap((r) => (r.routine_id === null ? [] : [r.routine_id]))
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM ch_reminders WHERE connection_id = ?').run(connectionId)
    },
  }
}

// --- reading "when" --------------------------------------------------------------------------------

/** What the `reminder` tool takes for the time: exactly one of `at`, `inMinutes`, `repeat`. */
export interface ReminderWhen {
  /** A local date and time in the team timezone, `YYYY-MM-DD HH:MM` (or with an explicit offset). */
  at?: string | undefined
  inMinutes?: number | undefined
  /** `daily`, `weekdays`, `weekly` (with `weekday`), `monthly` (with `dayOfMonth`), at `time`. */
  repeat?: 'daily' | 'weekdays' | 'weekly' | 'monthly' | undefined
  time?: string | undefined
  /** 0 = Sunday ... 6 = Saturday; or a day name. */
  weekday?: number | string | undefined
  dayOfMonth?: number | undefined
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const weekdayOf = (v: number | string | undefined): number | undefined => {
  if (v === undefined) return undefined
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 6 ? v : undefined
  const i = DAY_NAMES.indexOf(v.trim().toLowerCase())
  if (i >= 0) return i
  const j = DAY_SHORT.findIndex((d) => d.toLowerCase() === v.trim().toLowerCase())
  return j >= 0 ? j : undefined
}

export interface ReadWhen {
  spec: RoutineSpec
  /** The first fire (epoch ms). */
  firstAt: number
  /** The schedule in words with the absolute time and zone. */
  text: string
}

/** The moment as the confirmation states it: `Tue 2026-10-13 09:00 Asia/Jakarta`. */
export function absoluteTime(at: number, zone: string): string {
  const t = localTime(at, zone)
  return `${DAY_SHORT[wallOf(at, zone).weekday]} ${t.date} ${t.clock} ${t.zone}`
}

/**
 * Read a `when` in the team timezone. A one-time reminder must lie in the future; a repeat gets its
 * first fire from the cron in the zone. Errors are sentences for the model to read.
 */
export function readWhen(
  when: ReminderWhen,
  zone: string,
  now: number,
  nextCron: (expr: string, after: number) => number | null,
): ReadWhen | { error: string } {
  const given = [when.at, when.inMinutes, when.repeat].filter((x) => x !== undefined).length
  if (given !== 1) {
    return {
      error:
        'Say when with exactly one of: at ("YYYY-MM-DD HH:MM" in the team timezone), inMinutes, or repeat (with time).',
    }
  }
  if (when.inMinutes !== undefined) {
    if (!Number.isFinite(when.inMinutes) || when.inMinutes < 1 || when.inMinutes > 60 * 24 * 366)
      return { error: 'inMinutes must be from 1 to 527040.' }
    const at = now + Math.round(when.inMinutes) * 60_000
    return { spec: { kind: 'at', at }, firstAt: at, text: `once, ${absoluteTime(at, zone)}` }
  }
  if (when.at !== undefined) {
    const at = parseLocalDateTime(when.at, zone)
    if (at === undefined)
      return { error: `Could not read the time "${when.at}": use "YYYY-MM-DD HH:MM" in ${zone}.` }
    if (at <= now)
      return {
        error: `That time (${absoluteTime(at, zone)}) is in the past. Now it is ${absoluteTime(now, zone)}.`,
      }
    return { spec: { kind: 'at', at }, firstAt: at, text: `once, ${absoluteTime(at, zone)}` }
  }
  const clock = parseClock(when.time ?? '')
  if (clock === undefined)
    return { error: 'A repeating reminder needs time as "HH:MM" (24 hours).' }
  const mm = String(clock.minute)
  const hh = String(clock.hour)
  let expr: string
  let words: string
  switch (when.repeat) {
    case 'daily':
      expr = `${mm} ${hh} * * *`
      words = `every day at ${when.time}`
      break
    case 'weekdays':
      expr = `${mm} ${hh} * * 1-5`
      words = `every weekday (Mon to Fri) at ${when.time}`
      break
    case 'weekly': {
      const d = weekdayOf(when.weekday)
      if (d === undefined)
        return { error: 'A weekly reminder needs weekday (0 = Sunday to 6, or a day name).' }
      expr = `${mm} ${hh} * * ${d}`
      words = `every ${DAY_NAMES[d]} at ${when.time}`
      break
    }
    default: {
      const day = when.dayOfMonth
      if (day === undefined || !Number.isInteger(day) || day < 1 || day > 28)
        return { error: 'A monthly reminder needs dayOfMonth from 1 to 28.' }
      expr = `${mm} ${hh} ${day} * *`
      words = `on day ${day} of every month at ${when.time}`
    }
  }
  const first = nextCron(expr, now)
  if (first === null) return { error: 'That schedule never fires.' }
  return {
    spec: { kind: 'cron', expr, tz: zone },
    firstAt: first,
    text: `${words} (${zone}), first ${absoluteTime(first, zone)}`,
  }
}

/** A reminder text that already starts with its own label (`Reminder:`, `⏰ Reminder:`, `Reminder for Ana:`). */
const LABEL =
  /^\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)?reminder\b(?:\s+for\b[^:\n]{0,60})?\s*:\s*/iu

/** The text without a label of its own at the start. */
export const stripReminderLabel = (body: string): string => body.trim().replace(LABEL, '')

/**
 * What a reminder posts: the requested text verbatim, with the single label `Reminder:` added only
 * when the text has none. A reminder a member created for themselves is labelled
 * `Reminder for <name>:` (the name is whatever the caller renders, a mention token or a plain name).
 */
export function reminderText(body: string, forName?: string): string {
  const text = body.trim()
  if (forName === undefined) return LABEL.test(text) ? text : `Reminder: ${text}`
  return `Reminder for ${forName}: ${stripReminderLabel(text)}`.trimEnd()
}

// --- the message of a reminder ------------------------------------------------------------------

const norm = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A text that is a request to remind ("ingatkan ...", "remind me ...") and not the reminder itself. */
const REQUEST_START =
  /^(?:tolong\s+|please\s+|pls\s+|dong\s+|bisa\s+|can you\s+|could you\s+|kak\s+|bot\s+)*(?:ingatkan|ingetin|ingetkan|mengingatkan|diingatkan|jangan lupa(?: ingatkan)?|buatkan\s+(?:pengingat|reminder)|bikin(?:kan)?\s+(?:pengingat|reminder)|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|remind(?:er)?\b|please remind)/u

/**
 * The correction when `message` is not written as the reminder itself: it restates the request
 * (starts with "ingatkan", "remind me", equals or contains the request). `undefined` = fine. A
 * message the person quoted (`verbatim`) is never checked.
 */
export function misusedMessage(
  message: string,
  request: string | undefined,
  verbatim: boolean,
): string | undefined {
  if (verbatim) return undefined
  // a text that already carries its own label (`Reminder: ...`) is judged by what follows it
  const m = norm(stripReminderLabel(message))
  const asked = request === undefined ? '' : norm(request)
  const restates =
    REQUEST_START.test(m) ||
    (asked !== '' && (m === asked || (asked.includes(m) && m.length >= asked.length * 0.8)))
  if (!restates) return undefined
  return `ERROR: message must be the reminder itself, as it will read when it fires (for example "Waktunya pulang" or "Time to leave"), not the request ("ingatkan ...", "remind me ..."). Rewrite it from what the person wants to be reminded of, put their original words in request, and call again. Only if the person quoted exact words to post, pass them with verbatim: true.`
}
