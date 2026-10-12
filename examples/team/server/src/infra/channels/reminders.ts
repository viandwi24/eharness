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
import { parseClock, parseLocalDateTime, wallOf } from './time.ts'

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
