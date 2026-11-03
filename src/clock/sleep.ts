/**
 * The `sleep` tool: pause a turn for some minutes without holding a process. The call parks the
 * turn as an external wait (ADR-0027) whose timeout is the wake-up time; the session's wait timer
 * (or the inbox timer, or `expireWaits()` after a restart) continues the turn when it is due. A
 * worker loops "do a batch, sleep, do the next batch" this way while it costs nothing in between.
 *
 * @see docs/specs/34-clock.md
 * @see docs/decisions/0067-sleep-is-an-external-wait.md
 */
import type { Tool } from 'ai'
import { z } from 'zod'
import { externalTool } from '../index.ts'
import { formatInZone } from './time.ts'

export interface SleepOptions {
  /** The IANA zone the wake-up time is written in; a function is read on every call. */
  timezone: string | (() => string | Promise<string>)
  /** Longest single sleep in minutes. Default 240 (four hours). */
  maxMinutes?: number
  /** Tool description. Default {@link SLEEP_DESCRIPTION}. */
  description?: string
  /** Test seam: epoch milliseconds. Default `Date.now`. */
  now?: () => number
}

/** Input of the sleep tool. */
export interface SleepInput {
  minutes: number
  reason?: string | undefined
}

/** Default longest single sleep (minutes). */
export const SLEEP_MAX_MINUTES = 240

export const SLEEP_DESCRIPTION: string =
  'Pause this work for some minutes, then continue exactly here. Use it to pace work that must be ' +
  'spread over time: send a batch, sleep, send the next batch, until everything is done. While you ' +
  'sleep nothing runs and nothing is spent; you wake up with this tool answering. Save your progress ' +
  '(a tracker file or notes) before sleeping, so you know where to go on. Never sleep to wait for a ' +
  'person (ask them instead) and never sleep when nothing is left to do. A new message to you ends ' +
  'the sleep early.'

/** The wake-up text the tool answers with. */
function wakeText(
  minutes: number,
  until: number,
  zone: string,
  reason: string | undefined,
): string {
  const why =
    reason === undefined || reason.trim() === '' ? '' : ` (${reason.trim().slice(0, 200)})`
  return `Woke up after sleeping ${minutes} minute${minutes === 1 ? '' : 's'}${why}. It is now about ${formatInZone(until, zone)}. Continue the work from your saved progress; sleep again only if more pacing is needed.`
}

/**
 * The `sleep` tool (`read` risk: it changes nothing). An external tool without outside work: its
 * wait always ends by its timeout, whose result is the wake-up text.
 */
export function sleepTool(options: SleepOptions): Tool<SleepInput, string> {
  const max = options.maxMinutes ?? SLEEP_MAX_MINUTES
  const now = options.now ?? Date.now
  return externalTool<SleepInput, string>({
    description: options.description ?? SLEEP_DESCRIPTION,
    inputSchema: z.object({
      minutes: z.number().int().min(1).max(max).describe(`Minutes to sleep, 1 to ${max}.`),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe('What you wait for, in a few words ("pace the next batch").'),
    }),
    metadata: { risk: 'read', idempotent: true },
    // the wait is set when the call is parked; `start` only fixes the wake-up time and its text
    start: async (input) => {
      const minutes = Math.min(Math.max(Math.round(input.minutes), 1), max)
      const until = now() + minutes * 60_000
      let zone = 'UTC'
      try {
        zone = typeof options.timezone === 'function' ? await options.timezone() : options.timezone
      } catch {
        // the wake-up text falls back to UTC
      }
      return {
        timeoutAt: until,
        onTimeout: { output: wakeText(minutes, until, zone, input.reason) },
        payload: { sleep: true, minutes, until },
      }
    },
    // a `start` that never ran (a crash right after the commit) still wakes the turn
    timeoutMs: max * 60_000,
    onTimeout: { output: 'Woke up. Continue the work from your saved progress.' },
  })
}
