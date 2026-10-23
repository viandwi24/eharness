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
 *
 * @experimental Draft (spec 12): may change in a minor release (docs/engineering/api-stability.md).
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
  // the matching tier with the largest threshold wins, whatever the array order
  let rates: TokenRates = pricing
  let above = Number.NEGATIVE_INFINITY
  for (const tier of pricing.tiers ?? []) {
    if (prompt > tier.above && tier.above > above) {
      rates = tier
      above = tier.above
    }
  }
  const usd =
    uncached * rates.input +
    cacheRead * (rates.cacheRead ?? rates.input) +
    cacheWrite * (rates.cacheWrite ?? rates.input * 1.25) +
    text * rates.output +
    reasoning * (rates.reasoning ?? rates.output)
  return usd / 1_000_000
}

/**
 * Cost of a call of `model` from the catalog pricing; `undefined` when the model has no pricing.
 *
 * @experimental Draft (spec 12): may change in a minor release (docs/engineering/api-stability.md).
 */
export function costOf(
  catalog: ModelCatalog | undefined,
  model: LanguageModel,
  usage: LanguageModelUsage,
): number | undefined {
  const pricing = lookupModel(catalog, model)?.pricing
  return pricing === undefined ? undefined : computeCost(usage, pricing)
}

/** Where a settled cost came from. */
export type CostSource = 'provider' | 'estimate'

const asCost = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * The USD cost a provider billed for one call, read from `providerMetadata`: `<provider>.usage.cost`
 * (OpenRouter usage accounting) or `<provider>.cost` (AI Gateway, a number or a numeric string).
 * `undefined` when no provider reports one.
 *
 * @experimental Draft (spec 12): may change in a minor release (docs/engineering/api-stability.md).
 */
export function providerReportedCost(providerMetadata: unknown): number | undefined {
  if (typeof providerMetadata !== 'object' || providerMetadata === null) return undefined
  for (const entry of Object.values(providerMetadata)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { usage?: unknown; cost?: unknown }
    const usage = record.usage
    const nested =
      typeof usage === 'object' && usage !== null
        ? asCost((usage as { cost?: unknown }).cost)
        : undefined
    const cost = nested ?? asCost(record.cost)
    if (cost !== undefined) return cost
  }
  return undefined
}

/**
 * The cost to settle for a call: the provider-reported cost when `providerMetadata` carries one,
 * else the catalog estimate ({@link costOf}); `undefined` when neither is known.
 *
 * @experimental Draft (spec 12): may change in a minor release (docs/engineering/api-stability.md).
 */
export function settledCostOf(
  catalog: ModelCatalog | undefined,
  model: LanguageModel,
  usage: LanguageModelUsage,
  providerMetadata?: unknown,
): { costUsd: number; source: CostSource } | undefined {
  const reported = providerReportedCost(providerMetadata)
  if (reported !== undefined) return { costUsd: reported, source: 'provider' }
  const estimate = costOf(catalog, model, usage)
  return estimate === undefined ? undefined : { costUsd: estimate, source: 'estimate' }
}

/** Output tokens assumed by {@link estimateStepCostUsd} when the step sets no `maxOutputTokens`. */
export const DEFAULT_ESTIMATE_OUTPUT_TOKENS = 4_096

/**
 * Upper-bound estimate of one model call before it runs (the default reservation of
 * `budget.ledger`, spec 12 §4.1): `contextTokens` priced as uncached input plus
 * `maxOutputTokens` (default 4 096) priced as output, with the catalog pricing of `model` (tiers
 * apply). `undefined` when the model has no pricing.
 *
 * @example
 * ```ts
 * estimateStepCostUsd({ models, model, contextTokens: 20_000, maxOutputTokens: 1_000 })
 * ```
 * @see docs/specs/12-models-and-cost.md#2-pricing
 *
 * @experimental Draft (spec 12): may change in a minor release (docs/engineering/api-stability.md).
 */
export function estimateStepCostUsd(args: {
  models: ModelCatalog | undefined
  model: LanguageModel
  contextTokens: number
  maxOutputTokens?: number | undefined
}): number | undefined {
  return costOf(args.models, args.model, {
    inputTokens: count(args.contextTokens),
    inputTokenDetails: {
      noCacheTokens: count(args.contextTokens),
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: count(args.maxOutputTokens ?? DEFAULT_ESTIMATE_OUTPUT_TOKENS),
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  })
}
