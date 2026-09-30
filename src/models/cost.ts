/**
 * Cost of one model call from AI SDK usage.
 *
 * @see docs/specs/12-models-and-cost.md#3-cost
 */
import type { LanguageModel, LanguageModelUsage } from 'ai'
import { lookupModel } from './catalog.ts'
import type { ModelCatalog, ModelPricing, TokenRates } from './types.ts'

const count = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * USD cost of one model call (estimate). Input is split into uncached, cache-read and cache-write
 * tokens (`inputTokenDetails`), output into text and reasoning (`outputTokenDetails`; AI SDK
 * already includes reasoning in `outputTokens`). A tier reprices the whole call when the prompt
 * (all input tokens) is above its threshold.
 */
export function computeCost(usage: LanguageModelUsage, pricing: ModelPricing): number {
  const input = count(usage.inputTokens)
  const cacheRead = count(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWrite = count(usage.inputTokenDetails?.cacheWriteTokens)
  const uncached =
    usage.inputTokenDetails?.noCacheTokens !== undefined
      ? count(usage.inputTokenDetails.noCacheTokens)
      : Math.max(0, input - cacheRead - cacheWrite)
  const output = count(usage.outputTokens)
  const reasoning = Math.min(output, count(usage.outputTokenDetails?.reasoningTokens))
  const text = output - reasoning
  const prompt = uncached + cacheRead + cacheWrite
  let rates: TokenRates = pricing
  for (const tier of pricing.tiers ?? []) if (prompt > tier.above) rates = tier
  const usd =
    uncached * rates.input +
    cacheRead * (rates.cacheRead ?? rates.input) +
    cacheWrite * (rates.cacheWrite ?? rates.input * 1.25) +
    text * rates.output +
    reasoning * (rates.reasoning ?? rates.output)
  return usd / 1_000_000
}

/** Cost of a call of `model` from the catalog pricing; `undefined` when the model has no pricing. */
export function costOf(
  catalog: ModelCatalog | undefined,
  model: LanguageModel,
  usage: LanguageModelUsage,
): number | undefined {
  const pricing = lookupModel(catalog, model)?.pricing
  return pricing === undefined ? undefined : computeCost(usage, pricing)
}
