# Spec 12 — Models, cost and budgets

Status: **Draft (0.3)** (shipped in 0.3.0), updated for 0.4.0 and 0.5.0 (§4.1). Modules: `src/models/*`, cost accounting in `src/loop/steps.ts`,
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

```ts
export function estimateStepCostUsd(args: {
  models: ModelCatalog | undefined
  model: LanguageModel
  contextTokens: number
  maxOutputTokens?: number       // default 4 096
}): number | undefined
```

`estimateStepCostUsd` (exported, 0.5.0) is an upper-bound estimate of one call **before** it runs
— the default reservation of the budget ledger (§4.1): `contextTokens` priced as uncached input
plus `maxOutputTokens` priced as output, with the model's catalog pricing (tiers apply; no cache
discount is assumed). `undefined` when the model has no pricing.

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
summarizer model; a manual `compact()` charges `state.core.usage`, spec 06 §5.3), and so is a
pre-compaction flush (`source: 'compaction-flush'`, priced with the flush model, spec 06 §5.2a;
0.4.0).

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
  ledger?: BudgetLedgerConfig    // cross-session limits, §4.1 (0.5.0)
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

### 4.1 Budget ledger (normative)

Added in 0.5.0 (ADR-0029). Spending limits that span sessions — per user, tenant, agent, month,
whatever the app defines — are enforced inside the turn loop through an optional port.

```ts
export interface BudgetLedgerConfig {
  adapter: BudgetLedger
  scopes: (ctx: HarnessContext) => string[] | Promise<string[]>   // once per turn
  estimate?: (e: { ctx; model: LanguageModel; contextTokens: number; maxOutputTokens: number }) => number
  reservationTtlMs?: number          // default loop.turnTimeoutMs, else 600 000
  onError?: 'stop' | 'continue'      // default 'stop' (fail closed)
}

export interface BudgetLedger {
  reserve(req: { scopes: string[]; amountUsd: number; ttlMs: number; key: string }): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; scope: string; limitUsd: number; spentUsd: number }   // spentUsd = spent + reserved
  >
  commit(reservationId: string, actualUsd: number): Promise<void>
  release(reservationId: string): Promise<void>
  record(req: { scopes: string[]; amountUsd: number; key: string }): Promise<void>
  check(scopes: string[]): Promise<{
    ok: boolean
    scopes: Array<{ scope: string; limitUsd?: number; spentUsd: number; reservedUsd: number }>
  }>
}
```

**Adapter contract** (checked by `budgetLedgerConformance(factory)` in `eharness/testing`;
`memoryBudgetLedger({ limits })` in `eharness/storage/memory` passes it):

- A scope **with a limit** takes a reservation when it is not used up (spent + reserved < limit)
  and spent + reserved + amount ≤ limit; a scope **without a limit** always does. `reserve` is
  atomic over all scopes: all or nothing; refused → the first scope (in request order) that cannot
  take it. Concurrent callers (many processes) never push a scope's spent + reserved past its
  limit.
- `reserve` with the `key` of an **open** reservation returns that reservation (no second hold).
  A reservation expires `ttlMs` after it was taken: its amount stops counting.
- `commit` replaces the reservation by `actualUsd` (higher or lower; spent may exceed the limit).
  Idempotent per reservation; an expired reservation still charges `actualUsd`; unknown or
  released ids are ignored. `release` drops a reservation without cost; idempotent.
- `record` charges `amountUsd` on every scope once per `key`.
- `check` is read-only: per scope its limit (absent = none), spent and open reserved amounts; `ok`
  is false when a limited scope is used up.

**Core rules:**

1. **Before every model call** — step 0, every further step, the wrap-up step; not the compaction
   summarizer or flush (rule 3) — the core reserves `estimate` (default `estimateStepCostUsd` with
   the calibrated request estimate of the guard, spec 06 §2, and `settings.maxOutputTokens` or
   4 096) on the turn's scopes with `key: ${sessionId}:${turnId}:${stepIndex}`. A retry of the same
   step (overflow recovery, a degraded file, spec 05 §3) keeps its open reservation. Refused → the
   turn stops with `'cost-cap'` **before** the call (0 steps when it is the first), with `W_BUDGET`
   `details: { scope: 'ledger', ledgerScope, limitUsd, spentUsd, exceeded: true }` (once per turn).
   The reservation is taken after input delivery and the guard of the step; a refusal at that
   point leaves delivered input in the message like a compaction that uses up a budget (§4).
2. **After the step** the reservation is committed with the step's actual cost (`costOf` with the
   step model); a step whose usage AI SDK did not report (abort, timeout, provider failure before
   streaming) commits 0. A reservation still open when the turn ends (a stop between the
   reservation and the call's result) is released. Reservations of a dead process expire after
   `reservationTtlMs` (adapter).
3. **Nested usage** with a known price — `ctx.turn.addUsage` (subagents, gateways, a judge), the
   compaction summarizer and the pre-compaction flush — is recorded with `record` at the next step
   boundary (before that step's reservation) and at turn end, one call per contribution with
   `key: ${sessionId}:${turnId}:usage:${n}`. A failed record is retried at the next boundary with
   the same key. A manual `compact()` (no turn) records its summarizer / flush usage after the
   compaction (`key: ${sessionId}:compact:${id}:${n}`).
4. **Unpriced models**: the default estimate and the actual cost are 0 (`W_MODEL_UNPRICED` as in
   §4); the reservation still runs, so a used-up scope refuses the call. Priced nested usage is
   still recorded.
5. **Ledger errors**: a failing `reserve`, `scopes` or `estimate` before a call with
   `onError: 'stop'` (default) stops the turn with `'error'` before the call: `TurnResult.error`
   `{ code: 'EH_STORAGE', details: { operation: 'budget-ledger', call } }` (`call`: `'reserve'`,
   `'scopes'` or `'estimate'`), an `error` chunk, and the 0.4 error persistence. With
   `'continue'`: `W_BUDGET_LEDGER_FAILED` (`details.operation`) and the step runs unreserved (a
   throwing `scopes` disables the ledger for the turn). Commit, release and record failures are
   always `W_BUDGET_LEDGER_FAILED` warnings — the spend already happened.
6. **Composition**: the per-turn / per-session budgets (§4) and token caps still apply; the first
   cap reached stops the turn. `warnAt` is not evaluated for ledger scopes (soft limits and alerts
   are app policy, e.g. inside its adapter).
7. **Scopes, periods, prices and limits** are never interpreted by the core: scope strings are
   opaque; an empty scope list leaves the turn unlimited by the ledger (no calls).
   `memoryBudgetLedger` has static limits and no periods; `examples/postgres-budget-ledger.ts`
   shows monthly periods.

Without `budget.ledger`, behaviour, warnings and storage are exactly those of §4.
