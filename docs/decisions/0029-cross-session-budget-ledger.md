# ADR-0029: Cross-session budget ledger port

Status: **Proposed** · Date: 2026-10-06 · Amends: [ADR-0016](0016-model-catalog-and-budgets.md)

## Context

ADR-0016 gave every turn an estimated USD cost and two budgets: per turn and per session. Real
spending limits span sessions — per user, per tenant, per agent, per month — and they must hold
when many sessions run at once on many instances. Gateways (LiteLLM, Portkey, OpenRouter) enforce
such limits at the HTTP layer, with their own scope hierarchies, periods, price tables, soft
limits and alerts; the Claude Agent SDK's `maxBudgetUsd` is per run. A harness sees each model
call before it happens and can stop a turn cleanly (`'cost-cap'`, wrap-up rules, no half-written
tool calls), which a gateway rejection cannot. But the policy around limits differs per product.

A post-hoc check ("spent ≥ limit after the step", ADR-0016) is not enough across sessions: N
sessions that all read "$0.99 of $1 spent" each run one more step and overshoot by N steps.

## Decision

- **A small core port, not a policy engine.** `budget.ledger: { adapter: BudgetLedger, scopes,
  estimate?, reservationTtlMs?, onError? }`. The app resolves the turn's scopes (opaque strings,
  once per turn); the core never interprets scopes, periods, prices or limits.
- **Reserve / commit.** Before every model call (step 0, further steps, the wrap-up step; not the
  compaction summarizer) the core reserves an estimate of the call on all scopes, atomically and
  all-or-nothing. A refused reservation stops the turn with the existing `'cost-cap'` before the
  call (`W_BUDGET` with `details.scope: 'ledger'`). After the step the reservation is committed
  with the actual cost (`costOf`), or 0 when AI SDK reported no usage (abort, early provider
  failure). An open reservation of a turn that ended otherwise is released. Reservations of a dead
  process expire after `reservationTtlMs`. Overshoot across N concurrent sessions is therefore
  bounded by the estimates' errors, not by N steps.
- **Default estimate** `estimateStepCostUsd()` (exported): calibrated context tokens × input price
  + `maxOutputTokens` (default 4 096) × output price. Apps with better knowledge pass `estimate`.
- **Nested usage** (`ctx.turn.addUsage`, compaction summarizer, pre-compaction flush, later the
  approval-guard judge) is recorded with `record` at the next step boundary (before the next
  reservation) and at turn end, under keys derived from session, turn and sequence; adapters
  dedupe by key so retries never double-charge. A manual `compact()` records its usage too.
- **Fail closed by default.** A ledger exists to cap money: a failed `reserve` (or a throwing
  `scopes` / `estimate`) stops the turn with `'error'` (`EH_STORAGE`,
  `details.operation: 'budget-ledger'`) before the call. `onError: 'continue'` opts out with
  `W_BUDGET_LEDGER_FAILED`. Commit / record / release failures are warnings — the spend already
  happened.
- **Composition.** The 0.4 per-turn / per-session budgets and token caps stay; the first cap wins.
  `warnAt` is not evaluated for ledger scopes; soft limits and alerts are app policy (e.g. inside
  its adapter).
- **Adapters.** eharness ships `memoryBudgetLedger({ limits })` (static limits, no periods) and
  `budgetLedgerConformance` (`eharness/testing`); a Postgres ledger with monthly periods is an
  example (ADR-0008).

## Consequences

+ Limits per user / tenant / month hold across sessions and instances with one round trip per
  step; refusals end turns with the same stop reason and stream as 0.4 budgets.
+ Without `budget.ledger`, behaviour, warnings and storage are unchanged.
− One extra ledger round trip before and after every model call (and per nested contribution).
− Type-level: `W_BUDGET` `details.scope` gains `'ledger'`; `WarningCode` gains
  `W_BUDGET_LEDGER_FAILED`.
− Estimates are estimates: a reservation smaller than the actual cost can still overshoot by the
  difference; an aborted step whose usage AI SDK never reports commits 0.
− A refusal at a step boundary can come after input was delivered at that boundary (the same as a
  compaction that uses up a 0.4 budget): the input is stored and seen by the next turn.

## Alternatives considered

- Leave cross-session limits to gateways (rejected as the only option: no clean in-loop stop, no
  per-app scopes without a gateway; still a fine complement).
- Check-then-run without reservations (rejected: overshoot grows with concurrency).
- A pre-turn `check` in addition to the first reservation (rejected: the first reservation is the
  check, one round trip).
- Built-in scope hierarchy, periods and price tables (rejected: app policy; they differ per
  product and change often).
- Fail open by default (rejected: a ledger that silently stops enforcing is worse than none).
