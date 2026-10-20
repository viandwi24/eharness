/**
 * The context window an agent works in. Pure: no I/O.
 *
 * The window comes from the model (the catalog's `contextWindow` of the agent's effective model).
 * An agent may set a smaller limit of its own; a custom limit never exceeds the model's window
 * (when the model changes to a smaller one, the effective window is `min(custom, model)`).
 * History is summarized at a percentage of the effective window.
 */

/** The window assumed for a model the catalog does not list. */
export const UNKNOWN_MODEL_WINDOW = 200_000
/** The smallest custom limit (below it a prompt with its tools hardly fits). */
export const MIN_CONTEXT_WINDOW = 16_000
export const DEFAULT_COMPACT_AT_PERCENT = 80
export const MIN_COMPACT_AT_PERCENT = 50
export const MAX_COMPACT_AT_PERCENT = 95

export interface WindowInput {
  /** The model's real window; undefined = the catalog does not know it. */
  modelWindow: number | undefined
  /** The agent's own limit; null = follow the model. */
  custom: number | null
  /** Deprecated global ceiling (`TEAM_CONTEXT_CAP`); only applied when set. */
  ceiling?: number | undefined
}

/** The window an agent's sessions work in. */
export function effectiveWindow(input: WindowInput): number {
  const real = input.modelWindow ?? UNKNOWN_MODEL_WINDOW
  // an unknown model has no known maximum: the owner's number stands
  const own =
    input.custom === null
      ? real
      : input.modelWindow === undefined
        ? input.custom
        : Math.min(input.custom, real)
  return input.ceiling === undefined ? own : Math.min(own, input.ceiling)
}

/** The ratio the library's `compaction.summarizeAt` takes. */
export function compactRatio(percent: number): number {
  return clampPercent(percent) / 100
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_COMPACT_AT_PERCENT
  return Math.min(MAX_COMPACT_AT_PERCENT, Math.max(MIN_COMPACT_AT_PERCENT, Math.round(percent)))
}

/** An error text when `custom` cannot be used with a model of `modelWindow`; undefined = fine. */
export function customWindowProblem(
  custom: number,
  modelWindow: number | undefined,
): string | undefined {
  if (!Number.isInteger(custom) || custom < MIN_CONTEXT_WINDOW) {
    return `contextWindow must be a whole number of tokens, at least ${MIN_CONTEXT_WINDOW}`
  }
  if (modelWindow !== undefined && custom > modelWindow) {
    return `contextWindow ${custom} is larger than the model's window (${modelWindow} tokens)`
  }
  return undefined
}
