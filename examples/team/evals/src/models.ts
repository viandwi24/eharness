/** Real-model setup for the CLI: guards (CI, key), model construction and pricing. */
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelCatalog } from 'eharness'

type Env = Record<string, string | undefined>

interface ModelsDevModel {
  cost?: { input?: unknown; output?: unknown }
  limit?: { context?: unknown }
}

/** Real model calls never run in CI unless the developer opts in. */
export function assertMayRun(env: Env, allowCi: boolean): void {
  const ci = env.CI
  if (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false' && !allowCi) {
    throw new Error('refusing to run evals in CI (CI is set): pass --allow-ci to override')
  }
}

export function realModel(id: string, env: Env): LanguageModel {
  if (env.OPENROUTER_API_KEY) return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }).chat(id)
  if (env.AI_GATEWAY_API_KEY) return id // a plain id goes through the Vercel AI Gateway
  throw new Error(
    'no model key: set OPENROUTER_API_KEY or AI_GATEWAY_API_KEY (evals call a real model)',
  )
}

export interface Rates {
  input: number
  output: number
  context?: number
}

/** One fixed price list for every model of the run: USD per 1M tokens. */
export function flatCatalog(rates: Rates): ModelCatalog {
  return () => ({
    contextWindow: rates.context ?? 200_000,
    pricing: { input: rates.input, output: rates.output },
  })
}

/** Looks the model up in a models.dev document (any provider, by `id` or `provider/id`). */
export function ratesFromModelsDev(doc: unknown, id: string): Rates | undefined {
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  for (const provider of Object.values(
    (doc ?? {}) as Record<string, { models?: Record<string, ModelsDevModel> }>,
  )) {
    for (const [key, m] of Object.entries(provider?.models ?? {})) {
      if (key !== id && key !== bare) continue
      const c = m?.cost
      if (typeof c?.input === 'number' && typeof c?.output === 'number') {
        const context = m?.limit?.context
        return {
          input: c.input,
          output: c.output,
          ...(typeof context === 'number' ? { context } : {}),
        }
      }
    }
  }
  return undefined
}

export async function resolveRates(
  id: string,
  flags: { priceIn?: number; priceOut?: number },
  fetchFn: typeof fetch = fetch,
): Promise<Rates> {
  if (flags.priceIn !== undefined && flags.priceOut !== undefined) {
    return { input: flags.priceIn, output: flags.priceOut }
  }
  const res = await fetchFn('https://models.dev/api.json')
  if (res.ok) {
    const found = ratesFromModelsDev(await res.json(), id)
    if (found !== undefined) return found
  }
  throw new Error(
    `no price for ${id}: pass --price-in and --price-out (USD per 1M tokens); a budget needs prices`,
  )
}
