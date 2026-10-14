/**
 * `clock` plugin: the read-risk `datetime` tool. Models get dates, weekdays and time differences
 * wrong by hand; the tool answers them in the app's timezone.
 *
 *  - `now`      the current date and time (default zone, a named zone, UTC)
 *  - `convert`  a moment shown in another zone
 *  - `add`      a moment plus or minus a duration (calendar-aware days, weeks and months)
 *  - `diff`     the time between two moments
 *
 * @see docs/specs/34-clock.md
 */
import { tool } from 'ai'
import { z } from 'zod'
import { definePlugin, type HarnessPlugin } from '../index.ts'
import {
  addToMoment,
  diffMoments,
  durationWords,
  formatInZone,
  isValidTimeZone,
  parseMoment,
} from './time.ts'

export interface ClockOptions {
  /** The default IANA zone; a function is read on every call (a settings change applies at once). */
  timezone: string | (() => string | Promise<string>)
  /** Tool name. Default `'datetime'`. */
  toolName?: string
  /** Word used in the answer lines (`<label> time`, `<label> timezone`). Default `'Default'`. */
  label?: string
  /** Tool description. Default {@link DATETIME_DESCRIPTION}. */
  description?: string
  /** Test seam: epoch milliseconds. Default `Date.now`. */
  now?: () => number
}

/** Input of the datetime tool. */
export interface DatetimeInput {
  action?: 'now' | 'convert' | 'add' | 'diff' | undefined
  time?: string | undefined
  to?: string | undefined
  from_zone?: string | undefined
  zone?: string | undefined
  months?: number | undefined
  weeks?: number | undefined
  days?: number | undefined
  hours?: number | undefined
  minutes?: number | undefined
}

const inputSchema: z.ZodType<DatetimeInput> = z.object({
  action: z
    .enum(['now', 'convert', 'add', 'diff'])
    .optional()
    .describe('now (default), convert, add or diff.'),
  time: z
    .string()
    .max(64)
    .optional()
    .describe(
      'convert / add / diff: the moment, "YYYY-MM-DD HH:MM" (or a date, or "now") in `from_zone` or the default timezone, or ISO with an offset. Default now.',
    ),
  to: z.string().max(64).optional().describe('diff: the second moment, same formats.'),
  from_zone: z
    .string()
    .max(64)
    .optional()
    .describe('The IANA zone `time` and `to` are written in. Default: the default timezone.'),
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

export const DATETIME_DESCRIPTION: string =
  'The current date and time, and date arithmetic, in the default timezone of this app. ' +
  'now: the exact time now. convert: a moment in another zone. add: a moment plus or minus months/weeks/days/hours/minutes (calendar-aware). diff: the time between two moments. ' +
  'Use it instead of computing dates, weekdays or time differences yourself. Read-only.'

/** The text answer of one call; errors are `ERROR: ...` sentences for the model (never throws). */
export function runDatetime(
  input: DatetimeInput,
  defaultZone: string,
  now: number,
  label = 'Default',
): string {
  const base = isValidTimeZone(defaultZone) ? defaultZone : 'UTC'
  const fromZone = input.from_zone ?? base
  if (!isValidTimeZone(fromZone)) {
    return `ERROR: unknown timezone "${fromZone}". Use an IANA name like Asia/Jakarta.`
  }
  if (input.zone !== undefined && !isValidTimeZone(input.zone)) {
    return `ERROR: unknown timezone "${input.zone}". Use an IANA name like Europe/London.`
  }
  const read = (text: string | undefined, field: string): number | string => {
    const at = parseMoment(text ?? 'now', fromZone, now)
    return at === undefined
      ? `ERROR: could not read ${field} "${text}". Use "YYYY-MM-DD HH:MM" (in ${fromZone}), a date "YYYY-MM-DD", "now", or ISO with an offset.`
      : at
  }
  const show = (at: number): string[] => {
    const lines = [`${label} time: ${formatInZone(at, base)}`]
    if (input.zone !== undefined && input.zone !== base) {
      lines.push(`${input.zone}: ${formatInZone(at, input.zone)}`)
    }
    lines.push(`UTC: ${new Date(at).toISOString().replace('.000Z', 'Z')}`)
    return lines
  }
  const action = input.action ?? 'now'
  if (action === 'now') return [...show(now), `${label} timezone: ${base}.`].join('\n')
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
    return [`From: ${formatInZone(at, base)}`, ...show(addToMoment(at, fromZone, by))].join('\n')
  }
  const to = read(input.to, 'to')
  if (typeof to === 'string') return to
  const d = diffMoments(at, to, base)
  return [
    `From: ${formatInZone(at, base)}`,
    `To: ${formatInZone(to, base)}`,
    `${d.ms < 0 ? 'The second moment is earlier by' : 'Difference'}: ${durationWords(d.ms)} (${d.minutes} minutes)`,
    `Calendar days apart (${label.toLowerCase()} timezone): ${d.calendarDays}`,
  ].join('\n')
}

/** The `datetime` tool (`read` risk). Static: the same tool for every session. */
export function clock(options: ClockOptions): HarnessPlugin<'clock'> {
  const now = options.now ?? Date.now
  const toolName = options.toolName ?? 'datetime'
  return definePlugin({
    name: 'clock',
    setup: () => ({
      tools: {
        [toolName]: tool({
          description: options.description ?? DATETIME_DESCRIPTION,
          inputSchema,
          metadata: { risk: 'read' },
          execute: async (input): Promise<string> => {
            try {
              const zone =
                typeof options.timezone === 'function' ? await options.timezone() : options.timezone
              return runDatetime(input, zone, now(), options.label)
            } catch (error) {
              return `ERROR: the clock failed: ${String(error)}`
            }
          },
        }),
      },
    }),
  })
}
