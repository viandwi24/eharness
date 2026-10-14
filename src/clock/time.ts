/**
 * Time in a named IANA zone with `Intl.DateTimeFormat` only (no date library, runtime-neutral).
 * All functions are pure; instants are epoch milliseconds.
 *
 * @see docs/specs/34-clock.md
 */

/** The wall clock of an instant in a zone. */
export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  weekday: number
}

/** A calendar date without a zone. */
export interface LocalDate {
  year: number
  month: number
  day: number
}

/** Is this an IANA zone the runtime knows? */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number): string => String(n).padStart(2, '0')

/** The wall clock of an instant in a zone. Throws `RangeError` for an unknown zone. */
export function zonedParts(at: number, zone: string): ZonedParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(new Date(at))) p[part.type] = part.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: Math.max(0, WEEKDAYS.indexOf(p.weekday as string)),
  }
}

/**
 * The instant at which the wall clock of `zone` shows this date and time. A time that does not
 * exist (a DST gap) resolves forward; an ambiguous one (a DST overlap) resolves to the first.
 */
export function fromZoned(
  date: LocalDate,
  time: { hour: number; minute: number; second?: number },
  zone: string,
): number {
  const second = time.second ?? 0
  const naive = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, second)
  let guess = naive
  // the offset depends on the instant: settle in a few passes
  for (let i = 0; i < 3; i++) {
    const w = zonedParts(guess, zone)
    const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
    const delta = naive - shown
    if (delta === 0) break
    guess += delta
  }
  // an overlap has two answers: prefer the earlier one
  const earlier = guess - 3_600_000
  const e = zonedParts(earlier, zone)
  if (Date.UTC(e.year, e.month - 1, e.day, e.hour, e.minute, e.second) === naive) return earlier
  return guess
}

/** Offset of a zone from UTC at an instant, as `UTC+07:00` (`UTC` for none). */
export function offsetLabel(at: number, zone: string): string {
  const w = zonedParts(at, zone)
  const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const minutes = Math.round((shown - Math.floor(at / 1000) * 1000) / 60_000)
  if (minutes === 0) return 'UTC'
  const abs = Math.abs(minutes)
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `Tuesday 2026-10-13 09:41:07 Asia/Jakarta (UTC+07:00)`. */
export function formatInZone(at: number, zone: string): string {
  const w = zonedParts(at, zone)
  return `${WEEKDAY_NAMES[w.weekday]} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${zone} (${offsetLabel(at, zone)})`
}

/** Short form for a turn reminder: `Tue 2026-10-13 09:41 Asia/Jakarta (UTC+07:00)`. */
export function nowLine(at: number, zone: string): string {
  const w = zonedParts(at, zone)
  return `${WEEKDAYS[w.weekday]} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} ${zone} (${offsetLabel(at, zone)})`
}

/** The calendar date `days` after `date` (negative = before). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** `2026-10-13` as a date; undefined when it is not a real date. */
export function parseDate(text: string): LocalDate | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (m === null) return undefined
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  const back = new Date(Date.UTC(d.year, d.month - 1, d.day))
  return back.getUTCFullYear() === d.year &&
    back.getUTCMonth() + 1 === d.month &&
    back.getUTCDate() === d.day
    ? d
    : undefined
}

/**
 * Read a moment: `now`, `YYYY-MM-DD` (local midnight), `YYYY-MM-DD HH:MM[:SS]` (also with `T`) in
 * `zone`, or ISO 8601 with an offset / `Z`. Undefined when it cannot be read.
 */
export function parseMoment(text: string, zone: string, now: number): number | undefined {
  const t = text.trim()
  if (t === '' || t.toLowerCase() === 'now') return now
  const date = parseDate(t)
  if (date !== undefined) return fromZoned(date, { hour: 0, minute: 0 }, zone)
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? undefined : ms
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (m === null) return undefined
  const day = parseDate(m[1] as string)
  const hour = Number(m[2])
  const minute = Number(m[3])
  const second = m[4] === undefined ? 0 : Number(m[4])
  if (day === undefined || hour > 23 || minute > 59 || second > 59) return undefined
  return fromZoned(day, { hour, minute, second }, zone)
}

/** A calendar-aware shift. */
export interface Shift {
  months?: number
  weeks?: number
  days?: number
  hours?: number
  minutes?: number
}

/**
 * Plus or minus calendar months, weeks and days in `zone` (wall clock kept, so a day across a DST
 * change is still the same local time), then exact hours and minutes. Jan 31 + 1 month is the last
 * day of February.
 */
export function addToMoment(at: number, zone: string, by: Shift): number {
  const w = zonedParts(at, zone)
  let date: LocalDate = { year: w.year, month: w.month, day: w.day }
  if (by.months !== undefined && by.months !== 0) {
    const index = w.year * 12 + (w.month - 1) + by.months
    const year = Math.floor(index / 12)
    const month = (((index % 12) + 12) % 12) + 1
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    date = { year, month, day: Math.min(w.day, last) }
  }
  const days = (by.weeks ?? 0) * 7 + (by.days ?? 0)
  if (days !== 0) date = addDays(date, days)
  let out = at
  if (date.year !== w.year || date.month !== w.month || date.day !== w.day) {
    out = fromZoned(date, { hour: w.hour, minute: w.minute, second: w.second }, zone)
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

/** The time between two instants: exact milliseconds and the calendar days apart in `zone`. */
export function diffMoments(
  from: number,
  to: number,
  zone: string,
): { ms: number; minutes: number; calendarDays: number } {
  const a = zonedParts(from, zone)
  const b = zonedParts(to, zone)
  const calendarDays = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  )
  const ms = to - from
  return { ms, minutes: Math.round(ms / 60_000), calendarDays }
}
