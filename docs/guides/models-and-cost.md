# Models and cost

AI SDK knows a model only as `{ provider, modelId }`: no context window, no prices. eharness needs
both — the window for compaction and the context guard, prices for cost tracking and budgets — and
takes them from one optional **model catalog** you supply. The core never fetches anything.
Contract: spec 12, ADR-0016. Runnable: [`examples/budget-and-cost.ts`](../../examples/budget-and-cost.ts).

## A catalog

A record keyed by model id:

```ts
import { defineHarnessAgent, type ModelInfo } from 'eharness'

const sonnet: ModelInfo = {
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  // USD per 1M tokens
  pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models: { 'anthropic/claude-sonnet-4.6': sonnet },
})
```

A record is looked up by, in order: the full id (`anthropic/claude-sonnet-4.6` for a gateway
string, `anthropic.messages/claude-sonnet-4-6` for a provider instance), then
`<provider family>/<modelId>` (`anthropic/claude-sonnet-4-6`), then `<modelId>`
(`claude-sonnet-4-6`). Check what a model resolves to with `lookupModel(catalog, model)`.

Or a function, for your own database or naming scheme (a function that throws counts as unknown):

```ts
import { defineHarnessAgent, type ModelInfo } from 'eharness'

const prices: Record<string, ModelInfo> = {} // e.g. loaded at startup from your config service

defineHarnessAgent({
  model,
  models: (m) => prices[typeof m === 'string' ? m : m.modelId],
})
```

### From models.dev

[models.dev](https://models.dev) publishes limits and prices for most providers.
`modelsDevCatalog(json)` converts its database into a record keyed `<provider>/<model>` and
`<model>` (the first provider wins the short key). Fetch and cache it yourself — at build time, at
startup, or through your own endpoint:

```ts
import { defineHarnessAgent, lookupModel, modelsDevCatalog } from 'eharness'

const models = modelsDevCatalog(await (await fetch('https://models.dev/api.json')).json())
console.log(lookupModel(models, 'anthropic/claude-sonnet-4.6')) // check your ids resolve

defineHarnessAgent({ model: 'anthropic/claude-sonnet-4.6', models })
```

It maps `limit.context` → `contextWindow`, `limit.output` → `maxOutputTokens`, `cost.input`,
`output`, `cache_read`, `cache_write`, `reasoning` → rates, and context tiers (`cost.tiers` of type
`context`, or the older `cost.context_over_200k`) → `pricing.tiers`. Malformed entries are skipped.
You can merge it with your own overrides: `models: { ...modelsDevCatalog(json), ...myPrices }`.

## Context window

`contextWindow` (a number, or a function of the model) wins; else the catalog's `contextWindow`;
else 128k with a one-time `W_DEFAULT_CONTEXT_WINDOW` warning. With a catalog you can drop
`contextWindow`, and the window follows the model actually used (models can change per turn with
`send(…, { model })` or per step in `step.prepare`).

`ModelInfo.maxOutputTokens` is informational (your UI, your own checks): the core does not apply
it. To cap each call, set `settings.maxOutputTokens`; it also sizes the guard's reserve (spec 06 §1).

## Pricing

```ts
import type { ModelPricing } from 'eharness'

const gemini: ModelPricing = {
  input: 1.25, // USD per 1M uncached input tokens
  output: 10, // USD per 1M output tokens
  cacheRead: 0.31, // default: input (no discount known — an overestimate)
  cacheWrite: 1.25, // default: input × 1.25
  reasoning: 10, // default: output
  tiers: [{ above: 200_000, input: 2.5, output: 15, cacheRead: 0.625 }],
}
```

A tier reprices the **whole call** once its prompt (uncached + cache read + cache write input
tokens) is above `above`; the highest matching tier wins. `computeCost(usage, pricing)` is the
function the core uses, exported for your own model calls:

<!-- docs-check: continue -->
```ts
import { generateText } from 'ai'
import { computeCost } from 'eharness'

const { usage } = await generateText({ model, prompt: 'Hello' })
console.log(computeCost(usage, gemini)) // USD
```

## Where cost appears

Every step is priced with the model of that step. The turn's estimated cost is `costUsd` in:

| Where | Scope |
|---|---|
| `run.result.usage.costUsd` (`TurnResult`) | this turn, incl. `addUsage()` |
| `step.end` hook event `costUsd` | the turn so far |
| transient `data-eh.usage` part `costUsd` | the turn so far (live meter in the UI) |
| `metadata.eharness.usage.costUsd` on the assistant message | the turns that wrote the message (a `respond()` continuation adds to it) |
| `state.core.usage.costUsd` (`SessionStateSnapshot`) | all turns of the session |

It is **absent** (not 0) when nothing was priced. These are estimates: providers bill differently
(cache TTLs, regional or batch multipliers, per-request fees, aborted steps whose usage is never
reported). Use them for limits and dashboards; do not bill end users from them.

```ts
const result = await session.send('Summarize the report').result
console.log(result.usage.costUsd?.toFixed(4) ?? 'not priced')
```

## Nested model calls and subagents

A tool that calls a model itself reports the usage to the running turn, so it counts toward
`usage`, `costUsd`, token caps and budgets:

```ts
import { generateText, tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const cheap = 'anthropic/claude-haiku-4.5'

defineHarnessAgent({
  model,
  models,
  tools: {
    summarize: (ctx) =>
      tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          const result = await generateText({ model: cheap, prompt: `Summarize:\n${text}` })
          // priced with `models`; or { costUsd } when you know the exact cost (e.g. a gateway)
          ctx.turn?.addUsage(result.usage, { model: cheap, source: 'summarizer' })
          return result.text
        },
      }),
  },
})
```

`costUsd` wins over `model`; without either the usage counts tokens only. A subagent passes the
child turn's own estimate: `addUsage(usage, { costUsd: childResult.usage.costUsd, source })`
([subagents](subagents.md)).

## Budgets

```ts
import { defineHarnessAgent } from 'eharness'

defineHarnessAgent({
  model,
  models,
  budget: {
    maxTurnUsd: 2, // this turn, incl. addUsage()
    maxSessionUsd: 20, // all earlier turns (state.core.usage.costUsd) + this turn
    warnAt: 0.8, // default — W_BUDGET once per turn and budget at 80%
  },
})
```

- Checked after every step: when a budget is used up (spent ≥ limit), the turn stops with
  `'cost-cap'`. A step in flight is never cut, so the final cost can exceed the limit by one step.
- A session budget already used up by earlier turns stops a new turn before its first model call
  (`'cost-cap'`, 0 steps). Raise the budget or start a new session to continue.
- A used-up budget also suppresses `turn.beforeEnd` continuations and the wrap-up step.
- `W_BUDGET` is raised at `warnAt × limit` and when the budget is used up, with
  `details: { scope: 'turn' | 'session', limitUsd, spentUsd, exceeded }` — also streamed as a
  transient `data-eh.warning` part for the UI.
- With a budget configured, a step whose model has no pricing raises `W_MODEL_UNPRICED` once per
  model (`details.model`): its cost is left out of `costUsd` and the budgets, while its tokens still
  count toward `usage` and `loop.maxTurnOutputTokens`. Fix the catalog key (see `lookupModel`).
- Token limits stay available as `loop.maxTurnOutputTokens`, which also stops with `'cost-cap'`.

These budgets see one session. To cap a user, a tenant or a month across sessions, use a
[budget ledger](#budgets-across-sessions).

## Budgets across sessions

`budget.ledger` (0.5.0) enforces limits that span sessions and instances — per user, tenant,
agent, month, whatever your product needs. Before **every** model call the core reserves an
estimate of the call on your scopes, atomically; after the step it commits the actual cost. A
refused reservation stops the turn with `'cost-cap'` **before** the call, so N sessions running at
once cannot overshoot by N steps — only by how far the estimates were off.

```ts
import { defineHarnessAgent } from 'eharness'
import { memoryBudgetLedger } from 'eharness/storage/memory'

const ledger = memoryBudgetLedger({ limits: { 'tenant:acme': 50, 'user:ada': 5 } })

defineHarnessAgent({
  model,
  models, // prices for the estimates and the actual cost
  budget: {
    maxTurnUsd: 2, // the per-turn / per-session budgets still apply; the first cap wins
    ledger: {
      adapter: ledger,
      // resolved once per turn; opaque strings — eharness never parses them
      scopes: (ctx) => [`tenant:${ctx.runtime.tenantId}`, `user:${ctx.runtime.userId}`],
    },
  },
})
```

What the core does (spec 12 §4.1):

| When | Ledger call |
|---|---|
| before each model call (incl. the wrap-up step) | `reserve({ scopes, amountUsd: estimate, ttlMs, key })` — refused → `'cost-cap'` and `W_BUDGET` with `details.scope: 'ledger'`, `ledgerScope` |
| after the step | `commit(reservationId, actualUsd)` — 0 when the provider reported no usage (abort, early failure) |
| a turn that ends between reservation and result | `release(reservationId)` |
| `ctx.turn.addUsage`, compaction summarizer, flush | `record({ scopes, amountUsd, key })` at the next step boundary and at turn end (also after a manual `compact()`) |

- **Estimate.** The default is `estimateStepCostUsd()`: the request's estimated input tokens at the
  input price plus `settings.maxOutputTokens` (4 096 when unset) at the output price. Setting
  `maxOutputTokens` makes reservations tighter; or pass your own:
  `estimate: ({ model, contextTokens, maxOutputTokens }) => …` (return USD). An unpriced model
  estimates and costs 0 (`W_MODEL_UNPRICED`), but a used-up scope still refuses the call.
- **Fail closed.** When the ledger is down, the turn stops with `'error'`
  (`EH_STORAGE`, `details.operation: 'budget-ledger'`) before the call. `onError: 'continue'`
  runs the step unreserved with `W_BUDGET_LEDGER_FAILED`. Failures after the step (commit,
  record) are always warnings.
- **Expiry.** A reservation of a crashed process stops counting after `reservationTtlMs`
  (default `loop.turnTimeoutMs`, else 10 minutes).
- **Pre-turn check.** Not needed — the first reservation is the check. For a UI, call
  `ledger.check(scopes)` (`{ ok, scopes: [{ scope, limitUsd?, spentUsd, reservedUsd }] }`).
- **Policy is yours.** Scope hierarchy, periods (monthly, rolling), price lists, soft limits and
  alerts live in your adapter. `warnAt` does not apply to ledger scopes; raise your own alert
  inside `reserve` / `commit`.

`memoryBudgetLedger()` keeps static limits in one process — fine for tests and for several agent
instances in one process. A deployment needs a shared store: `examples/postgres-budget-ledger.ts`
implements the port with monthly UTC periods (one atomic `UPDATE … WHERE spent + reserved +
amount <= limit` per scope inside a function) and runs `budgetLedgerConformance` from
`eharness/testing` — run the same suite against your own adapter:

```ts
import { test } from 'bun:test'
import { budgetLedgerConformance } from 'eharness/testing'

for (const c of budgetLedgerConformance((limits) => myLedger({ limits }))) test(c.name, c.run)
```

A gateway that enforces budgets (LiteLLM, Portkey, OpenRouter) is a fine complement: the ledger
stops turns cleanly inside the loop; the gateway is the last line of defence.
