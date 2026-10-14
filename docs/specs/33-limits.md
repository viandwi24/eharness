# Spec 33 — Limits (`eharness/limits`)

Status: **Draft (0.8)**. Module: `src/limits/*`. Builds on spec 01 (plugins, hooks), 05 §3.1
(`turn.beforeEnd`, wrap-up) and 12 §4.1 (budget ledger).

Two small plugins that every long-running product ends up writing. The module imports core only
through `src/index.ts`, has no dependency and no Node-only code. Generalised from the team app.

## 1. `stepBudget`

```ts
stepBudget({
  chunk?: number,                                   // steps added per extension, default 30
  cap: number | ((ctx: HarnessContext) => number),  // hard cap of total steps in a turn
  wrapUp?: boolean | string,                        // reminder in the last steps, default false
}): HarnessPlugin<'step-budget'>
```

A turn starts with the small `loop.maxSteps` of the runner. When it stops with `max-steps`,
`turn.beforeEnd` returns `{ extendSteps: min(chunk, cap - stepsRun) }` while there is room.

- The cap is the app's policy: a number, or a function of the session context (e.g. by session
  kind or origin). `cap <= 0` means "never extend": the runner's budget stands.
- No extension when the turn made no progress since the last continuation (`idleContinues > 0`).
  The progress guard (spec 05 §3.2) ends a repeating turn long before the cap.
- `e.stepIndex` of `turn.beforeEnd` is the index of the last step, so `stepIndex + 1` steps have
  run; the plugin never overshoots the cap.
- `wrapUp` adds a volatile `step.prepare` reminder when at most 3 steps remain before the cap
  (`true`: `STEP_BUDGET_WRAP_UP`; a string replaces it). It is a nudge only: `loop.wrapUp` (the
  core's tool-less summary step) stays the agent's setting and still runs when the budget is spent.
- Extensions count as continuations: `loop.maxContinues` still applies.

## 2. `budgetNotice`

When the budget ledger refuses a reservation the core stops the turn with `cost-cap` before the
model call and stores an empty assistant message; a chat shows nothing. Two parts fix that:

```ts
trackRefusals(ledger: BudgetLedger): RefusalTracker  // { ledger, take(sessionId), peek(sessionId) }
budgetNotice({
  refusals?: RefusalTracker,
  text?: (refusal: BudgetRefusal | undefined, sessionId: string) => string,  // '' = no notice
}): HarnessPlugin<'budget-notice'>
```

- Give `tracker.ledger` to `budget.ledger.adapter`; it forwards every call and remembers the last
  refusal (`scope`, `limitUsd`, `spentUsd`) per session (bounded to 500 sessions; the session id is
  read from the reservation key `${sessionId}:${turnId}:${stepIndex}`).
- `turn.end` with `stop: 'cost-cap'` stores an `eh.notice` (`level: 'warning'`, `code:
  'EH_COST_CAP'`) with `text(refusal, sessionId)` (default `defaultBudgetText`). An empty string
  stores no notice (a session that is not a chat). Without `refusals` the text is generic.
- A failure to store the notice is logged, never thrown.

## Security notes

Nothing here widens authority: `stepBudget` only raises a step count up to an app-set cap, and
every step still reserves against the ledger.
