/**
 * `clock` plugin: the `datetime` tool every agent has in every session (chats, tasks, programs,
 * routines, channels). One clock for the whole app: times are read and shown in the team timezone
 * (Settings), the same zone that schedules routines and reminders, stamps channel messages and
 * decides what "today" means. Read-only; it never asks.
 *
 *  - `now`      the current date and time (team zone, a named zone, UTC, epoch)
 *  - `convert`  a moment shown in another zone
 *  - `add`      a moment plus or minus a duration (calendar-aware days, weeks and months)
 *  - `diff`     the time between two moments
 *
 * The turn reminder of every agent states the current time too (`agent-factory.ts`); the tool is
 * for the exact time mid-turn and for date arithmetic, which models get wrong by hand.
 */
import { tool } from 'ai'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import {
  addDays,
  isZone,
  offsetLabel,
  parseDate,
  parseLocalDateTime,
  wallOf,
  zonedToEpoch,
} from '../channels/time.ts'

export const DATETIME_TOOL = 'datetime'

export interface ClockPluginOptions {
  /** The team timezone (IANA), read on every call: a change in Settings applies at once. */
  timezone: () => string
  /** Test seam. */
  now?: () => number
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number): string => String(n).padStart(2, '0')

/** `Tuesday 2026-10-13 09:41:07 Asia/Jakarta (UTC+07:00)`. */
export function describeMoment(at: number, zone: string): string {
  const w = wallOf(at, zone)
  return `${DAYS[w.weekday]} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${zone} (${offsetLabel(at, zone)})`
}

/** The line every turn reminder carries: `Tue 2026-10-13 09:41 Asia/Jakarta (UTC+07:00)`. */
export function nowLine(at: number, zone: string): string {
  const w = wallOf(at, zone)
  return `${DAYS[w.weekday]?.slice(0, 3)} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} ${zone} (${offsetLabel(at, zone)})`
}

/** `now`, `YYYY-MM-DD` (midnight), `YYYY-MM-DD HH:MM[:SS]` in `zone`, or ISO with an offset / `Z`. */
export function readMoment(text: string, zone: string, now: number): number | undefined {
  const t = text.trim()
  if (t === '' || t.toLowerCase() === 'now') return now
  const date = parseDate(t)
  if (date !== undefined) return zonedToEpoch(date, { hour: 0, minute: 0 }, zone)
  const seconds = /^(\d{4}-\d{2}-\d{2}[T\s]+\d{1,2}:\d{2}):(\d{2})$/.exec(t)
  if (seconds !== null) {
    const base = parseLocalDateTime(seconds[1] as string, zone)
    const s = Number(seconds[2])
    return base === undefined || s > 59 ? undefined : base + s * 1000
  }
  const local = parseLocalDateTime(t, zone)
  if (local !== undefined) return local
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(t) && /\d{4}-\d{2}-\d{2}T/.test(t)) {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

/** Plus or minus calendar months, weeks and days in `zone` (wall clock kept), then exact hours and minutes. */
export function shiftMoment(
  at: number,
  zone: string,
  by: { months?: number; weeks?: number; days?: number; hours?: number; minutes?: number },
): number {
  const w = wallOf(at, zone)
  let date = { year: w.year, month: w.month, day: w.day }
  if (by.months !== undefined && by.months !== 0) {
    const index = w.year * 12 + (w.month - 1) + by.months
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    // Jan 31 + 1 month = the last day of February
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    date = { year, month, day: Math.min(w.day, last) }
  }
  const days = (by.weeks ?? 0) * 7 + (by.days ?? 0)
  if (days !== 0) date = addDays(date, days)
  let out = at
  if (date.year !== w.year || date.month !== w.month || date.day !== w.day) {
    out = zonedToEpoch(date, { hour: w.hour, minute: w.minute }, zone) + w.second * 1000
  }
  return out + ((by.hours ?? 0) * 60 + (by.minutes ?? 0)) * 60_000
}

/** `3 days 4 hours 5 minutes` (largest units first; `0 minutes` for less than one). */
export function durationWords(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 60_000)
  const parts: string[] = []
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) parts.push(`${d} day${d === 1 ? '' : 's'}`)
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m > 0 || parts.length === 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  return parts.join(' ')
}

const inputSchema = z.object({
  action: z
    .enum(['now', 'convert', 'add', 'diff'])
    .optional()
    .describe('now (default), convert, add or diff.'),
  time: z
    .string()
    .max(64)
    .optional()
    .describe(
      'convert / add / diff: the moment, "YYYY-MM-DD HH:MM" (or a date, or "now") in `from_zone` or the team timezone, or ISO with an offset. Default now.',
    ),
  to: z.string().max(64).optional().describe('diff: the second moment, same formats.'),
  from_zone: z
    .string()
    .max(64)
    .optional()
    .describe('The IANA zone `time` and `to` are written in. Default: the team timezone.'),
  zone: z
    .string()
    .max(64)
    .optional()
    .describe(
      'now / convert / add: also show the result in this IANA zone (e.g. "Europe/London").',
    ),
  months: z
    .number()
    .int()
    .min(-1200)
    .max(1200)
    .optional()
    .describe('add: months (negative = back).'),
  weeks: z.number().int().min(-5200).max(5200).optional().describe('add: weeks.'),
  days: z.number().int().min(-36500).max(36500).optional().describe('add: days.'),
  hours: z.number().int().min(-876000).max(876000).optional().describe('add: hours.'),
  minutes: z.number().int().min(-52560000).max(52560000).optional().describe('add: minutes.'),
})

export const DATETIME_DESCRIPTION =
  'The current date and time, and date arithmetic, in the team timezone (the one zone the whole team uses: routines, reminders, chat times, "today"). ' +
  'now: the exact time now. convert: a moment in another zone. add: a moment plus or minus months/weeks/days/hours/minutes (calendar-aware). diff: the time between two moments. ' +
  'Use it instead of computing dates, weekdays or time differences yourself. Read-only.'

/** The text answer of one call; errors are sentences for the model (never throws). */
export function runDatetime(input: z.infer<typeof inputSchema>, team: string, now: number): string {
  const teamZone = isZone(team) ? team : 'UTC'
  const fromZone = input.from_zone ?? teamZone
  if (!isZone(fromZone))
    return `ERROR: unknown timezone "${fromZone}". Use an IANA name like Asia/Jakarta.`
  if (input.zone !== undefined && !isZone(input.zone)) {
    return `ERROR: unknown timezone "${input.zone}". Use an IANA name like Europe/London.`
  }
  const read = (text: string | undefined, field: string): number | string => {
    const at = readMoment(text ?? 'now', fromZone, now)
    return at === undefined
      ? `ERROR: could not read ${field} "${text}". Use "YYYY-MM-DD HH:MM" (in ${fromZone}), a date "YYYY-MM-DD", "now", or ISO with an offset.`
      : at
  }
  const show = (at: number): string[] => {
    const lines = [`Team time: ${describeMoment(at, teamZone)}`]
    if (input.zone !== undefined && input.zone !== teamZone) {
      lines.push(`${input.zone}: ${describeMoment(at, input.zone)}`)
    }
    lines.push(`UTC: ${new Date(at).toISOString().replace('.000Z', 'Z')}`)
    return lines
  }
  const action = input.action ?? 'now'
  if (action === 'now') return [...show(now), `Team timezone: ${teamZone}.`].join('\n')
  const at = read(input.time, 'time')
  if (typeof at === 'string') return at
  if (action === 'convert') return show(at).join('\n')
  if (action === 'add') {
    const by = {
      months: input.months,
      weeks: input.weeks,
      days: input.days,
      hours: input.hours,
      minutes: input.minutes,
    }
    if (Object.values(by).every((v) => v === undefined || v === 0)) {
      return 'ERROR: add needs at least one of months, weeks, days, hours or minutes.'
    }
    // calendar units follow the wall clock of the zone the time was written in
    const out = shiftMoment(at, fromZone, by)
    return [`From: ${describeMoment(at, teamZone)}`, ...show(out)].join('\n')
  }
  const to = read(input.to, 'to')
  if (typeof to === 'string') return to
  const ms = to - at
  const startDay = wallOf(at, teamZone)
  const endDay = wallOf(to, teamZone)
  const calendarDays = Math.round(
    (Date.UTC(endDay.year, endDay.month - 1, endDay.day) -
      Date.UTC(startDay.year, startDay.month - 1, startDay.day)) /
      86_400_000,
  )
  return [
    `From: ${describeMoment(at, teamZone)}`,
    `To: ${describeMoment(to, teamZone)}`,
    `${ms < 0 ? 'The second moment is earlier by' : 'Difference'}: ${durationWords(ms)} (${Math.round(ms / 60_000)} minutes)`,
    `Calendar days apart (team timezone): ${calendarDays}`,
  ].join('\n')
}

export function clock(options: ClockPluginOptions): HarnessPlugin<'clock'> {
  const now = options.now ?? Date.now
  return definePlugin({
    name: 'clock',
    // static: the same tool for every session, so it sits in the cached prefix
    setup: () => ({
      tools: {
        [DATETIME_TOOL]: tool({
          description: DATETIME_DESCRIPTION,
          inputSchema,
          execute: async (input) => runDatetime(input, options.timezone(), now()),
        }),
      },
    }),
  })
}
