/**
 * Reading the `due` and `expires` of a standing order: ISO 8601 with an offset, `YYYY-MM-DD HH:MM`
 * in the team timezone, `today 12:00`, `tomorrow 09:00`, `12:00` (the next time the clock shows it),
 * or `in 90 minutes` / `in 2 hours` / `in 3 days`. Errors are sentences for the model to read.
 */
import { addDays, dateOf, parseClock, parseLocalDateTime, zonedToEpoch } from '../channels/time.ts'

export function resolveOrderTime(
  text: string,
  zone: string,
  now: number,
): { at: number } | { error: string } {
  const t = text.trim().toLowerCase()
  const bad = {
    error: `Could not read the time "${text}": use "YYYY-MM-DD HH:MM" in ${zone}, "today 12:00", "tomorrow 09:00" or "in 2 hours".`,
  }
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day)s?$/.exec(t)
  if (rel !== null) {
    const n = Number(rel[1])
    const unit =
      rel[2] === 'day' ? 86_400_000 : rel[2] === 'hour' || rel[2] === 'hr' ? 3_600_000 : 60_000
    return { at: now + Math.round(n * unit) }
  }
  const day = /^(today|tomorrow)\s+(\d{1,2}:\d{2})$/.exec(t)
  const clockOnly = /^\d{1,2}:\d{2}$/.test(t) ? t : undefined
  if (day !== null || clockOnly !== undefined) {
    const clock = parseClock((day?.[2] ?? clockOnly) as string)
    if (clock === undefined) return bad
    const today = dateOf(now, zone)
    if (day?.[1] === 'tomorrow') return { at: zonedToEpoch(addDays(today, 1), clock, zone) }
    const at = zonedToEpoch(today, clock, zone)
    if (day?.[1] === 'today') return { at }
    return { at: at > now ? at : zonedToEpoch(addDays(today, 1), clock, zone) }
  }
  const at = parseLocalDateTime(text, zone)
  return at === undefined ? bad : { at }
}
