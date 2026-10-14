/**
 * `stepBudget` plugin: a turn starts with the small base budget (`loop.maxSteps`); when it runs
 * out while the turn is still making progress, `turn.beforeEnd` extends it in chunks up to a hard
 * cap the app decides per session. A turn that repeats itself is stopped by the progress guard
 * long before the cap, so the cap is about runaway length, not cost.
 *
 * @see docs/specs/33-limits.md
 */
import { definePlugin, type HarnessContext, type HarnessPlugin } from '../index.ts'

export interface StepBudgetOptions {
  /** Steps added per extension (default 30). */
  chunk?: number
  /**
   * The hard cap (total steps of a turn). A number, or a function of the session context; `0` or
   * less means "never extend" (the runner's own `loop.maxSteps` stands).
   */
  cap: number | ((ctx: HarnessContext) => number)
  /**
   * Warn the model in the last steps before the cap (a volatile step reminder). `true` uses the
   * default text, a string replaces it. The core's own tool-less wrap-up step (`loop.wrapUp`)
   * still runs when the budget is finally spent. Default `false`.
   */
  wrapUp?: boolean | string
  /**
   * What happens when the turn reaches the hard cap while it still makes progress: it gets
   * `extraSteps` more steps (default 4), once, and a reminder in each of them, instead of going
   * straight to the wrap-up. The app uses the reminder to hand the rest of the job over (for
   * example to a background worker). Never applies twice in a turn, and not when `cap <= 0`.
   */
  onCap?: {
    reminder: string | ((ctx: HarnessContext) => string)
    extraSteps?: number
  }
}

export const STEP_BUDGET_WRAP_UP: string =
  'You are close to the step limit of this turn. Stop starting new work: finish what you are doing and summarize what is done and what is left.'

/** Steps before the cap at which the wrap-up reminder starts. */
const WARN_WINDOW = 3

export function stepBudget(options: StepBudgetOptions): HarnessPlugin<'step-budget'> {
  const chunk = Math.max(1, Math.floor(options.chunk ?? 30))
  const capOf = (ctx: HarnessContext): number =>
    typeof options.cap === 'function' ? options.cap(ctx) : options.cap
  const wrapText =
    options.wrapUp === true
      ? STEP_BUDGET_WRAP_UP
      : typeof options.wrapUp === 'string'
        ? options.wrapUp
        : undefined
  const extraSteps = Math.max(1, Math.floor(options.onCap?.extraSteps ?? 4))
  /** Turns that used their `onCap` extension. */
  const capped = new Set<string>()
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
          // stepIndex is the 0-based index of the last step: stepIndex + 1 steps have run
          const cap = capOf(ctx)
          const room = cap - (e.stepIndex + 1)
          if (room > 0) return { extendSteps: Math.min(chunk, room) }
          const turnId = ctx.turn?.id
          if (
            options.onCap !== undefined &&
            cap > 0 &&
            turnId !== undefined &&
            !capped.has(turnId)
          ) {
            capped.add(turnId)
            return { extendSteps: extraSteps }
          }
          return undefined
        },
        'turn.end': (_ctx, e: { turnId: string }): void => {
          capped.delete(e.turnId)
        },
        'step.prepare': (ctx, e: { stepIndex: number }): { reminder: string } | undefined => {
          const turnId = ctx.turn?.id
          if (options.onCap !== undefined && turnId !== undefined && capped.has(turnId)) {
            const r = options.onCap.reminder
            return { reminder: typeof r === 'function' ? r(ctx) : r }
          }
          if (wrapText === undefined) return undefined
          const cap = capOf(ctx)
          if (cap <= 0 || cap - e.stepIndex > WARN_WINDOW) return undefined
          return { reminder: wrapText }
        },
      },
    }),
  })
}
