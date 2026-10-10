/**
 * Cron and interval maths on `croner` (parsing and next-slot only: no timers, `paused: true`).
 * IANA timezones come from the JS runtime. Pure functions of the clock they are given.
 */
import { Cron } from 'croner'
import type { ScheduleCalc } from '../app/ports.ts'
import { DomainError, invalid } from '../domain/errors.ts'
import { MIN_EVERY_MS, type RoutineSpec } from '../domain/routines.ts'

function cronOf(expr: string, tz: string): Cron {
  try {
    return new Cron(expr, { timezone: tz, paused: true })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw invalid(`invalid cron expression or timezone: ${why}`, 'INVALID_SCHEDULE')
  }
}

export function croneSchedule(): ScheduleCalc {
  const next = (spec: RoutineSpec, afterMs: number): number | null => {
    switch (spec.kind) {
      case 'every':
        return afterMs + spec.everyMs
      case 'at':
        return spec.at > afterMs ? spec.at : null
      case 'cron': {
        try {
          const at = cronOf(spec.expr, spec.tz).nextRun(new Date(afterMs))
          return at === null ? null : at.getTime()
        } catch (error) {
          if (error instanceof DomainError) throw error
          // croner reports a bad timezone only when it computes a date
          throw invalid(
            `invalid cron timezone or date: ${error instanceof Error ? error.message : String(error)}`,
            'INVALID_SCHEDULE',
          )
        }
      }
    }
  }
  return {
    next,
    validate(spec) {
      if (spec.kind === 'every') {
        if (!Number.isInteger(spec.everyMs) || spec.everyMs < MIN_EVERY_MS) {
          throw invalid(
            `everyMs must be an integer of at least ${MIN_EVERY_MS}`,
            'INVALID_SCHEDULE',
          )
        }
        return
      }
      if (spec.kind === 'at') {
        if (!Number.isFinite(spec.at))
          throw invalid('at must be epoch milliseconds', 'INVALID_SCHEDULE')
        return
      }
      cronOf(spec.expr, spec.tz)
      // cost guard: two consecutive slots must be at least MIN_EVERY_MS apart
      const first = next(spec, Date.now())
      const second = first === null ? null : next(spec, first)
      if (first === null) throw invalid('the cron expression never fires', 'INVALID_SCHEDULE')
      if (second !== null && second - first < MIN_EVERY_MS) {
        throw invalid(
          `a routine cannot fire more often than every ${MIN_EVERY_MS} ms`,
          'INVALID_SCHEDULE',
        )
      }
    },
  }
}
