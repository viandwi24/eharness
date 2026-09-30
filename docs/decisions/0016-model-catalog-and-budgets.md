# ADR-0016: Model limits and prices come from an app-supplied catalog

Status: **Accepted** · Date: 2026-09-30

## Context

AI SDK exposes a model only as `{ provider, modelId }` — no context window, no prices. Compaction
needs the window; unattended runs need a money limit (Claude Agent SDK `maxBudgetUsd`, SWE-agent
cost limits). opencode loads models.dev, Claude Code bundles a price table, Codex has no USD at all.
eharness must stay runtime-neutral, dependency-free and must not fetch anything by itself.

## Decision

- One optional `models` catalog (record or function) gives `contextWindow`, `maxOutputTokens` and
  `pricing` (USD per 1M: input, output, cache read/write, reasoning, context tiers).
  `modelsDevCatalog(json)` adapts models.dev; the application fetches and caches the JSON.
- The core prices each step with the step model (`computeCost`, AI SDK v7 usage details) and
  accumulates `costUsd` in the turn result, message metadata, `data-eh.usage`, `StepEndEvent` and
  `state.core.usage` (additive fields).
- `budget.maxTurnUsd` / `maxSessionUsd` stop the turn with the existing `'cost-cap'` after the step
  that used the budget up; `W_BUDGET` warns at `warnAt` (0.8).

## Consequences

+ Budgets work across providers; the context window no longer has to be configured twice.
+ No new dependency, no network access in the core.
− Costs are estimates (aborted steps, provider multipliers, per-request fees are not seen).
− The check is after a step, so spending can exceed a budget by one step.

## Alternatives considered

- Bundle a price table (rejected: goes stale, grows the package, violates "not a data product").
- Fetch models.dev in the core (rejected: network I/O in a library, runtime neutrality).
- A separate `'budget'` stop reason (rejected: `'cost-cap'` already means "spending limit reached").
