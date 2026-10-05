# Spec 12 — Models, cost and budgets

Status: **Draft (0.3)** (shipped in 0.3.0), updated for 0.4.0. Modules: `src/models/*`, cost accounting in `src/loop/steps.ts`,
`src/session/turn.ts`.

AI SDK knows a model only as `{ provider, modelId }`: no context window, no prices. The core needs
both — the window for compaction and the guard (spec 06), prices for cost and budgets. The
application supplies them through one optional catalog; the core never fetches anything.

## 1. Model info

```ts
defineHarnessAgent({
  models?: ModelCatalog          // Record<string, ModelInfo> | ((model: LanguageModel) => ModelInfo | undefined)
  budget?: BudgetConfig          // §4
})

export interface ModelInfo {
  contextWindow?: number         // total window in tokens
  maxOutputTokens?: number
  pricing?: ModelPricing         // §2
}
```

`lookupModel(catalog, model)` resolves a record by, in order: `describeModel(model)`
(`anthropic/claude-sonnet-4.6` for gateway strings, `anthropic.messages/claude-sonnet-4-6` for
provider instances), `<provider family>/<modelId>` (`anthropic/claude-sonnet-4-6`), `<modelId>`.
A function catalog that throws counts as unknown.

**Context window** (spec 06 §1): `contextWindow` (number or function) wins; else the catalog's
`contextWindow`; else 128k with `W_DEFAULT_CONTEXT_WINDOW`.

`modelsDevCatalog(data)` converts the models.dev database (`https://models.dev/api.json`, fetched
and cached by the application) into a record keyed `<provider>/<model>` and `<model>` (first
provider wins). It maps `limit.context` → `contextWindow`, `limit.output` → `maxOutputTokens`,
`cost.{input, output, cache_read, cache_write, reasoning}` → rates, `cost.tiers[]` with
`tier.type: 'context'` → tiers (`tier.size` → `above`), and the legacy `cost.context_over_200k` →
a tier above 200_000. Malformed entries are skipped.

## 2. Pricing

```ts
export interface TokenRates {              // USD per 1M tokens
  input: number
  output: number
  cacheRead?: number                       // default: input (no discount known)
  cacheWrite?: number                      // default: input × 1.25
  reasoning?: number                       // default: output
}
export interface ModelPricing extends TokenRates {
  tiers?: Array<TokenRates & { above: number }>
}
```

A tier reprices the **whole call** once the prompt (uncached + cache read + cache write input
tokens) is above `above`; the highest matching tier wins (Gemini / GPT-5.x / long-context pricing).

## 3. Cost

`computeCost(usage, pricing)` (exported) — the estimate for one call from AI SDK
`LanguageModelUsage`:

- input: `inputTokenDetails.noCacheTokens` (else `inputTokens − cacheRead − cacheWrite`) at
  `input`, `cacheReadTokens` at `cacheRead`, `cacheWriteTokens` at `cacheWrite`;
- output: `outputTokenDetails.reasoningTokens` at `reasoning`, the rest of `outputTokens` at
  `output` (AI SDK includes reasoning in `outputTokens`; it is never added twice);
- missing, negative or NaN counts are 0.

Per step the core prices the usage with the **step model** (models may change per step). A step
without pricing is *unpriced* (it adds no cost). `ctx.turn.addUsage(usage, options)` adds nested
usage: `options.costUsd` (known cost, e.g. from a gateway) wins, else `options.model` is priced
from the catalog, else it is unpriced. `source` may still be passed as a plain string. The
summarizer calls of compaction are charged the same way (`source: 'compaction'`, priced with the
summarizer model; a manual `compact()` charges `state.core.usage`, spec 06 §5.3).

The turn's cost appears as `costUsd` in `TurnResult.usage`, `metadata.eharness.usage` (cumulative
over the turns that wrote the message, like the token counts), `data-eh.usage` (turn so far),
`StepEndEvent.costUsd` (turn so far) and `state.core.usage.costUsd` (all turns of the session).
It is **absent** when nothing was priced. All figures are estimates: providers bill differently
(cache TTLs, regional or batch multipliers, per-request fees, aborted steps whose usage AI SDK never
reports). Do not bill end users from them.

## 4. Budgets

```ts
export interface BudgetConfig {
  maxTurnUsd?: number            // this turn incl. addUsage
  maxSessionUsd?: number         // state.core.usage.costUsd + this turn
  warnAt?: number                // default 0.8
}
```

- Checked after every step, together with the stop rules (spec 05 §3.1): when the rules would
  continue (or pending input would extend a `'complete'`) and a budget is used up (spent ≥ limit),
  the turn stops with `'cost-cap'`. A step in flight is never cut, so the final cost may exceed
  the limit by one step.
- A session budget already used up by earlier turns stops a new turn **before** its first model
  call (`'cost-cap'`, 0 steps).
- A used-up budget suppresses `turn.beforeEnd` continuations and the wrap-up step, and skips
  compaction before its summarizer runs (`W_BUDGET` with `details.compaction: true`, spec 06
  §5.3). A compaction that uses up the budget stops the turn with `'cost-cap'` before the next
  model call.
- `W_BUDGET` once per turn and budget when spending reaches `warnAt × limit`
  (`details: { scope: 'turn' | 'session', limitUsd, spentUsd, exceeded: false }`) and when it is
  used up (`exceeded: true`).
- With a budget configured, a step whose model has no pricing raises `W_MODEL_UNPRICED` once per
  model (`details.model`); its usage does not count.

Token caps stay available as `loop.maxTurnOutputTokens` (spec 01 §1), also stopping with
`'cost-cap'`.
