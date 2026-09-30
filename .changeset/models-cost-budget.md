---
"eharness": minor
---

**New: model catalog, cost and USD budgets** (spec 12, ADR-0016):

- `defineHarnessAgent({ models })` — a record keyed by model id, or a function — gives each model's
  `contextWindow`, `maxOutputTokens` and `pricing` (USD per 1M tokens: input, output, cache read,
  cache write, reasoning, context tiers). The context window is taken from it when `contextWindow`
  is not set.
- `modelsDevCatalog(json)` converts the models.dev database (fetched by your app); `lookupModel`
  and `computeCost` are exported.
- Every turn records its estimated cost as `costUsd` in `TurnResult.usage`,
  `metadata.eharness.usage`, `data-eh.usage`, `StepEndEvent.costUsd` and `state.core.usage` (all
  additive, absent when nothing was priced).
- `budget: { maxTurnUsd, maxSessionUsd, warnAt }` stops the turn with `'cost-cap'` when a budget
  is used up; warnings `W_BUDGET` and `W_MODEL_UNPRICED`.
- `ctx.turn.addUsage(usage, { model | costUsd, source })` prices nested usage (subagents); a plain
  string `source` still works.
