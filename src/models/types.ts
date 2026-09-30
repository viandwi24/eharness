import type { LanguageModel } from 'ai'

/**
 * USD per 1M tokens.
 *
 * @see docs/specs/12-models-and-cost.md#2-pricing
 */
export interface TokenRates {
  input: number
  output: number
  /** Cached input read. Default: `input` (no discount known — an overestimate). */
  cacheRead?: number
  /** Cached input write. Default: `input × 1.25`. */
  cacheWrite?: number
  /** Reasoning output. Default: `output`. */
  reasoning?: number
}

/**
 * Prices of a model. A tier applies to the **whole call** once its prompt (input incl. cached
 * tokens) is above `above` tokens; the highest matching tier wins.
 */
export interface ModelPricing extends TokenRates {
  tiers?: Array<TokenRates & { above: number }>
}

/**
 * What the core needs to know about a model: its limits (compaction, guard) and prices (cost,
 * budgets). Every field is optional.
 *
 * @see docs/specs/12-models-and-cost.md#1-model-info
 */
export interface ModelInfo {
  /** Total context window in tokens (used when `contextWindow` is not configured). */
  contextWindow?: number
  /** Maximum output tokens of one call. */
  maxOutputTokens?: number
  pricing?: ModelPricing
}

/**
 * Model information for a model, or `undefined` when unknown. A record is looked up by
 * `describeModel(model)` (`anthropic/claude-sonnet-4.6`, `anthropic.messages/claude-sonnet-4-6`),
 * then `<provider family>/<modelId>` (`anthropic/claude-sonnet-4-6`), then `<modelId>`.
 */
export type ModelCatalog =
  | Record<string, ModelInfo>
  | ((model: LanguageModel) => ModelInfo | undefined)
