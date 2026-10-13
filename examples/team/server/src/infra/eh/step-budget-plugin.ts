/**
 * `stepBudget` plugin (production feedback: an audit of a whole group stopped with "I ran out of
 * steps" after 25 tool calls). A turn starts with a small base budget (`loop.maxSteps`); when it
 * runs out while the turn is still making progress, `turn.beforeEnd` extends it in chunks up to a
 * hard cap that depends on what kind of session it is. A turn that repeats itself is stopped by the
 * library's progress detection (`stuck`) long before the cap, and every step still counts against
 * the budget ledger, so the cap is about runaway length, not cost.
 *
 * Caps: a chat turn (a person waits) 120 steps; a delegated child or an assigned task 200; a
 * background worker `maxWorkerSteps` (default 400). Programs, rehearsals, heartbeats and routines keep
 * the budget their runner sets (their authority and budgets are the client's decision).
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import { originOfSession } from '../../domain/run-profiles.ts'

export interface StepBudgetOptions {
  /** Is this a background worker session (`isWorkerSession`)? */
  isWorker: (sessionId: string) => boolean
  /** Hard cap of a worker turn (default 400). */
  maxWorkerSteps?: number
  /** Steps added per extension (default 30). */
  chunk?: number
}

/** Runs whose budget is set by their runner: never extended. */
const FIXED: ReadonlySet<string> = new Set(['program', 'rehearsal', 'heartbeat', 'routine'])

/** The hard cap of a turn of this session (0 = never extended). */
export function stepCapOf(
  sessionId: string,
  hasParent: boolean,
  options: Pick<StepBudgetOptions, 'isWorker' | 'maxWorkerSteps'>,
): number {
  if (options.isWorker(sessionId)) return options.maxWorkerSteps ?? 400
  const origin = originOfSession(sessionId, hasParent)
  if (FIXED.has(origin)) return 0
  if (hasParent || origin === 'task') return 200
  return 120
}

export function stepBudget(options: StepBudgetOptions): HarnessPlugin<'step-budget'> {
  const chunk = options.chunk ?? 30
  return definePlugin({
    name: 'step-budget',
    setup: () => ({
      hooks: {
        'turn.beforeEnd': (
          ctx,
          e: { stop: string; stepIndex: number; idleContinues: number },
        ): { extendSteps: number } | undefined => {
          if (e.stop !== 'max-steps') return undefined
          // continuations without progress are the library's signal that the turn is going nowhere
          if (e.idleContinues > 0) return undefined
          const cap = stepCapOf(ctx.session.id, ctx.session.parent !== undefined, options)
          const room = cap - e.stepIndex
          return room > 0 ? { extendSteps: Math.min(chunk, room) } : undefined
        },
      },
    }),
  })
}
