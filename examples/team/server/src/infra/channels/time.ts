/**
 * Time in a named zone, without a date library (docs/plans/P41-team-channels.md, phase L6): the
 * team timezone decides what "today", "9:00" and "tomorrow" mean in a chat. Pure.
 */

import {
  addDays,
  fromZoned,
  isValidTimeZone,
  type LocalDate,
  offsetLabel,
  parseDate,
  zonedParts,
} from 'eharness/clock'

// zone arithmetic lives in `eharness/clock`; this module keeps the team's own helpers on top of it
export { addDays, type LocalDate, offsetLabel, parseDate }
export const isZone: (zone: string) => boolean = isValidTimeZone
export const wallOf: typeof zonedParts = zonedParts

/** The instant at which the wall clock of `zone` shows this date and time (DST gaps resolve forward). */
export const zonedToEpoch = (
  date: LocalDate,
  time: { hour: number; minute: number },
  zone: string,
): number => fromZoned(date, time, zone)

export const dateOf = (at: number, zone: string): LocalDate => {
  const w = wallOf(at, zone)
  return { year: w.year, month: w.month, day: w.day }
}

export const startOfDay = (date: LocalDate, zone: string): number =>
  zonedToEpoch(date, { hour: 0, minute: 0 }, zone)

export const isoDate = (d: LocalDate): string =>
  `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`

export function parseClock(text: string): { hour: number; minute: number } | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  return m === null ? undefined : { hour: Number(m[1]), minute: Number(m[2]) }
}

/**
 * A local date and time as a person writes it: `2026-10-13 09:00` or `2026-10-13T09:00` in the
 * zone, or with an explicit offset / `Z` (then the zone is not used).
 */
export function parseLocalDateTime(text: string, zone: string): number | undefined {
  const t = text.trim()
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(t) && /T|\s/.test(t)) {
    const ms = Date.parse(t.replace(' ', 'T'))
    return Number.isNaN(ms) ? undefined : ms
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{1,2}:\d{2})$/.exec(t)
  if (m === null) return undefined
  const date = parseDate(m[1] as string)
  const clock = parseClock(m[2] as string)
  if (date === undefined || clock === undefined) return undefined
  return zonedToEpoch(date, clock, zone)
}

/** A window of the day for a recap, in the zone. `to` is exclusive. */
export interface TimeWindow {
  from: number
  to: number
  label: string
}

/**
 * `today`, `yesterday`, `last_24h`, `last_7d`, a date (`2026-10-12`), or an explicit pair of local
 * date-times. Day windows start at local midnight; `today` ends now.
 */
export function resolveWindow(
  input: { window?: string | undefined; from?: string | undefined; to?: string | undefined },
  zone: string,
  now: number,
): TimeWindow | { error: string } {
  if (input.from !== undefined || input.to !== undefined) {
    const from = input.from === undefined ? now - 86_400_000 : parseLocalDateTime(input.from, zone)
    const to = input.to === undefined ? now : parseLocalDateTime(input.to, zone)
    if (from === undefined || to === undefined)
      return { error: `Could not read the time: use "YYYY-MM-DD HH:MM" in ${zone}.` }
    if (to <= from) return { error: 'The window ends before it starts.' }
    return { from, to, label: `${input.from ?? 'now-24h'} to ${input.to ?? 'now'}` }
  }
  const w = (input.window ?? 'today').trim().toLowerCase()
  const today = dateOf(now, zone)
  if (w === 'today')
    return { from: startOfDay(today, zone), to: now, label: `today ${isoDate(today)}` }
  if (w === 'yesterday') {
    const y = addDays(today, -1)
    return {
      from: startOfDay(y, zone),
      to: startOfDay(today, zone),
      label: `yesterday ${isoDate(y)}`,
    }
  }
  if (w === 'last_24h') return { from: now - 86_400_000, to: now, label: 'the last 24 hours' }
  if (w === 'last_7d') {
    return { from: startOfDay(addDays(today, -6), zone), to: now, label: 'the last 7 days' }
  }
  const d = parseDate(w)
  if (d !== undefined)
    return { from: startOfDay(d, zone), to: startOfDay(addDays(d, 1), zone), label: isoDate(d) }
  return {
    error: `Unknown window "${input.window}". Use today, yesterday, last_24h, last_7d, a date (YYYY-MM-DD), or from/to.`,
  }
}

/** Is `at` inside a daily quiet window `from` to `to` (`HH:MM` in `zone`; may wrap midnight)? */
export function inQuietHours(
  at: number,
  quiet: { from: string; to: string } | undefined,
  zone: string,
): boolean {
  if (quiet === undefined) return false
  const from = parseClock(quiet.from)
  const to = parseClock(quiet.to)
  if (from === undefined || to === undefined) return false
  const w = wallOf(at, zone)
  const minutes = w.hour * 60 + w.minute
  const a = from.hour * 60 + from.minute
  const b = to.hour * 60 + to.minute
  if (a === b) return false
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b
}
