---
"eharness": minor
---

Cross-session budget ledger (spec 12 §4.1, ADR-0029).

- New optional port `BudgetLedger` (`reserve`, `commit`, `release`, `record`, `check`) configured
  as `budget.ledger: { adapter, scopes, estimate?, reservationTtlMs?, onError? }`. Before every
  model call (wrap-up step included) the core reserves an estimate on the turn's app-defined
  scopes, atomically; after the step it commits the actual cost (0 when the provider reported no
  usage). A refused reservation stops the turn with `'cost-cap'` before the call (`W_BUDGET` with
  `details.scope: 'ledger'`, `ledgerScope`). Nested usage (`ctx.turn.addUsage`, the compaction
  summarizer and flush, a manual `compact()`) is recorded with idempotent keys.
- Fails closed: a failing ledger before a call ends the turn with `'error'` (`EH_STORAGE`,
  `details.operation: 'budget-ledger'`); `onError: 'continue'` runs the step unreserved with the
  new warning `W_BUDGET_LEDGER_FAILED`. Commit / record failures are warnings.
- `memoryBudgetLedger({ limits })` in `eharness/storage/memory` (static limits, no periods),
  `budgetLedgerConformance(factory)` in `eharness/testing`, and the `estimateStepCostUsd()` helper
  (context tokens × input price + `maxOutputTokens`, default 4 096, × output price). New types
  `BudgetLedgerConfig`, `BudgetReservation`, `BudgetScopeStatus`, `BudgetEstimateEvent`.
- **Type-level change:** `W_BUDGET` `details.scope` gains `'ledger'` (code that matches
  `'turn' | 'session'` exhaustively must add it); `WarningCode` gains `W_BUDGET_LEDGER_FAILED`.
  No new stop reason. Without `budget.ledger`, behaviour, warnings and storage are unchanged.
