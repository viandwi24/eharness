/**
 * Model catalog lookup and the models.dev adapter.
 *
 * @see docs/specs/12-models-and-cost.md#1-model-info
 */
import type { LanguageModel } from 'ai'
import { describeModel, providerOf } from '../internal/model.ts'
import type { ModelCatalog, ModelInfo, ModelPricing, TokenRates } from './types.ts'

/** Lookup keys of a model, most specific first. */
function keysOf(model: LanguageModel): string[] {
  const full = describeModel(model)
  const slash = full.indexOf('/')
  const modelId = slash >= 0 ? full.slice(slash + 1) : full
  const family = providerOf(model)
  const keys = [full]
  if (family !== undefined) keys.push(`${family}/${modelId}`)
  keys.push(modelId)
  return [...new Set(keys)]
}

/**
 * Find the {@link ModelInfo} of `model` in a catalog. A function catalog that throws counts as
 * unknown.
 */
export function lookupModel(
  catalog: ModelCatalog | undefined,
  model: LanguageModel,
): ModelInfo | undefined {
  if (catalog === undefined) return undefined
  if (typeof catalog === 'function') {
    try {
      return catalog(model) ?? undefined
    } catch {
      return undefined
    }
  }
  for (const key of keysOf(model)) {
    const info = Object.hasOwn(catalog, key) ? catalog[key] : undefined
    if (info !== undefined) return info
  }
  return undefined
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function rates(cost: Record<string, unknown>): TokenRates | undefined {
  const input = num(cost.input)
  const output = num(cost.output)
  if (input === undefined || output === undefined) return undefined
  const out: TokenRates = { input, output }
  const cacheRead = num(cost.cache_read)
  const cacheWrite = num(cost.cache_write)
  const reasoning = num(cost.reasoning)
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
  if (reasoning !== undefined) out.reasoning = reasoning
  return out
}

function pricingOf(cost: unknown): ModelPricing | undefined {
  if (cost === null || typeof cost !== 'object') return undefined
  const c = cost as Record<string, unknown>
  const base = rates(c)
  if (base === undefined) return undefined
  const tiers: NonNullable<ModelPricing['tiers']> = []
  if (Array.isArray(c.tiers)) {
    for (const t of c.tiers as Array<Record<string, unknown>>) {
      const tier = t?.tier as { type?: unknown; size?: unknown } | undefined
      const above = num(tier?.size)
      const r = rates(t ?? {})
      if (tier?.type === 'context' && above !== undefined && r !== undefined)
        tiers.push({ ...r, above })
    }
  }
  const over = c.context_over_200k
  if (tiers.length === 0 && over !== null && typeof over === 'object') {
    const r = rates(over as Record<string, unknown>)
    if (r !== undefined) tiers.push({ ...r, above: 200_000 })
  }
  return tiers.length > 0 ? { ...base, tiers: tiers.sort((a, b) => a.above - b.above) } : base
}

/**
 * Build a catalog from the models.dev database (`https://models.dev/api.json`, fetched by the
 * application). Keys are `<provider>/<model>` and `<model>` (first provider wins for the short
 * key). Unknown or malformed entries are skipped.
 *
 * @example
 * ```ts
 * const models = modelsDevCatalog(await (await fetch('https://models.dev/api.json')).json())
 * defineHarnessAgent({ model, models, budget: { maxTurnUsd: 2 } })
 * ```
 */
export function modelsDevCatalog(data: unknown): Record<string, ModelInfo> {
  const catalog: Record<string, ModelInfo> = {}
  if (data === null || typeof data !== 'object') return catalog
  for (const [providerId, provider] of Object.entries(data as Record<string, unknown>)) {
    const models = (provider as { models?: unknown } | null)?.models
    if (models === null || typeof models !== 'object') continue
    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const m = raw as { limit?: Record<string, unknown>; cost?: unknown }
      const info: ModelInfo = {}
      const context = num(m.limit?.context)
      const output = num(m.limit?.output)
      if (context !== undefined && context > 0) info.contextWindow = context
      if (output !== undefined && output > 0) info.maxOutputTokens = output
      const pricing = pricingOf(m.cost)
      if (pricing !== undefined) info.pricing = pricing
      catalog[`${providerId}/${modelId}`] = info
      if (!Object.hasOwn(catalog, modelId)) catalog[modelId] = info
    }
  }
  return catalog
}
