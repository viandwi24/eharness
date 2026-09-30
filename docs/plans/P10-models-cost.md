# P10 — Model catalog, cost and budgets

Status: done · Owner: agent · Branch: `feat/long-running`

## Goal

Apps can tell the core each model's window and prices once; every turn reports its USD cost and
USD budgets stop runaway turns and sessions (ADR-0016).

## Specs

- `docs/specs/12-models-and-cost.md` (new)
- spec 01 §1/§4/§5, spec 03 §3/§4, spec 05 §7, spec 06 §1, spec 10 §2/§4

## Owns

`src/models/**`; cost accounting in `src/loop/steps.ts` and `src/session/turn.ts`.

## Checklist

- [x] `ModelInfo`, `ModelPricing`, `ModelCatalog`, `lookupModel`, `modelsDevCatalog`
- [x] `computeCost` (cache read/write, reasoning, tiers, NaN-safe)
- [x] Per-step pricing with the step model; nested `addUsage` with `model` / `costUsd`
- [x] `costUsd` in result, metadata, `data-eh.usage`, `StepEndEvent`, `state.core.usage`
- [x] `budget` (`maxTurnUsd`, `maxSessionUsd`, `warnAt`), `W_BUDGET`, `W_MODEL_UNPRICED`
- [x] Context window from the catalog
- [x] Tests, specs, ADR-0016, changeset

## Acceptance criteria

- [x] Turn and session budgets stop with `'cost-cap'`; a used-up session budget stops before the first call
- [x] lint, typecheck, test green

## Open questions

- Anthropic 1h cache writes (2×) are priced at `cacheWrite`; AI SDK does not split 5m/1h writes.
- Pre-flight estimates (stop before a step that would exceed the budget) are not implemented.
