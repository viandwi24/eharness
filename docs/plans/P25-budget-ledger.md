# P25 — Cross-session `BudgetLedger` port

Status: in progress · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art item **#3** (verdict split: a small core port + per-run checks are generic;
scope hierarchy, periods, prices, soft limits and alerts are app policy — LiteLLM, Portkey,
OpenRouter enforce them at the gateway; Claude Agent SDK `maxBudgetUsd` is per run). Also
addresses the 0.4.0 audit row "Budget pre-flight estimate" for ledger budgets.

Process (0.5.0): develop first, one gate at the end of the phase, consolidated review at the end
of the release.

## Goal

Spending limits that span sessions (per user, tenant, agent, month — whatever the app defines)
are enforced **inside** the turn loop through an optional `BudgetLedger` port: before the first
model call and before every further step the core **reserves** an estimate of the step's cost
on the app's scopes (atomically, so concurrent sessions in many instances cannot overshoot by
more than their reservations), **commits** the actual cost after the step, and stops with the
existing `'cost-cap'` stop reason when a reservation is refused. Nested usage (`addUsage`,
compaction summarizer, P26 judge) is recorded too. eharness ships the port, a memory adapter and a
conformance suite; a Postgres ledger with periods is an example.

## Specs / docs to read

- `docs/specs/12-models-and-cost.md` §2 (pricing, `costOf`), §3 (cost, `addUsage`), §4
  (budgets, `W_BUDGET`, `W_MODEL_UNPRICED`, checks after every step and before the first call)
- `docs/specs/05-session-and-storage.md` §3 (lifecycle, where steps start), §3.1 (stop rules),
  §4 / §7 (adapter contract style, `setIf`)
- `docs/specs/06-compaction.md` §5.3 (summarizer usage counts, budget skip)
- `docs/specs/10-errors-and-stop-reasons.md` §2 (`W_BUDGET`), §4 (`'cost-cap'`)
- `docs/specs/01-agent-and-plugins.md` §1 (config), §4 (`TurnInfo.addUsage`)
- ADR-0016 (model catalog and budgets), ADR-0008 (memory adapters only)
- `src/loop/steps.ts` (`overBudget`, warn thresholds), `src/session/turn.ts` (`budgetOverrun`,
  summarizer usage), `src/models/cost.ts`, `src/compaction/tokens.ts` (context estimate),
  `examples/budget-and-cost.ts`, `docs/guides/models-and-cost.md`

**AI SDK verified (2026-10-06):** no AI SDK API is involved beyond `LanguageModelUsage` (already
used); 7.0.128 changes nothing there
(`https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md`). Atomic counter
pattern for the example: `UPDATE … SET reserved = reserved + $1 WHERE … AND spent + reserved + $1
<= limit RETURNING …` (re-verify against `https://www.postgresql.org/docs/17/sql-update.html`).
**No devDependency bump.**

## Owns

`BudgetConfig` and the new port types in `src/agent/types.ts`, the budget parts of
`src/loop/steps.ts` and `src/session/turn.ts`, `src/models/cost.ts` (estimate helper),
`memoryBudgetLedger()` in `src/storage/memory.ts`, `src/testing/budget-ledger.conformance.ts`
(new) + `src/testing/index.ts`, spec 12 §4 (new §4.1), spec 10 §2, ADR-0029 (new),
`examples/postgres-budget-ledger.ts` (new), `examples/budget-and-cost.ts`,
`docs/guides/models-and-cost.md`.

## Design

```ts
export interface BudgetLedger {
  /** Atomically reserve `amountUsd` on every scope, or nothing. Refused → the first scope over its limit. */
  reserve(req: { scopes: string[]; amountUsd: number; ttlMs: number; key: string /* `${sessionId}:${turnId}:${stepIndex}` */ })
    : Promise<{ ok: true; reservationId: string } | { ok: false; scope: string; limitUsd: number; spentUsd: number }>
  /** Replace a reservation by the actual cost (may be higher or lower). Idempotent per reservationId. */
  commit(reservationId: string, actualUsd: number): Promise<void>
  /** Drop a reservation without cost (step failed before the model call). Idempotent. */
  release(reservationId: string): Promise<void>
  /** Record cost without a reservation (nested usage, summarizer, judge). Idempotent per key. */
  record(req: { scopes: string[]; amountUsd: number; key: string }): Promise<void>
  /** Read-only check, e.g. for a UI or before a turn. */
  check(scopes: string[]): Promise<{ ok: boolean; scopes: Array<{ scope: string; limitUsd?: number; spentUsd: number; reservedUsd: number }> }>
}

defineHarnessAgent({
  budget: {
    …0.4 fields,
    ledger?: {
      adapter: BudgetLedger
      /** App-defined scopes of this turn, e.g. [`user:${id}`, `tenant:${t}`]; resolved once per turn. */
      scopes: (ctx: HarnessContext) => string[] | Promise<string[]>
      /** Default: estimateStepCostUsd() — context tokens × input price + maxOutputTokens × output price. */
      estimate?: (e: { ctx: HarnessContext; model: LanguageModel; contextTokens: number; maxOutputTokens: number }) => number
      reservationTtlMs?: number          // default loop.turnTimeoutMs or 600_000
      onError?: 'stop' | 'continue'      // ledger call failed; default 'stop' (fail closed)
    }
  },
})
export function estimateStepCostUsd(…): number | undefined   // exported helper (spec 12)
```

Normative rules (spec 12 new §4.1):

1. **Before every model call** (step 0 included, wrap-up step included, compaction summarizer
   excluded — it is recorded) the core reserves `estimate` on `scopes`. Refused → the turn stops
   with `'cost-cap'` **before** the call (0 steps when it is the first), `W_BUDGET` with
   `details: { scope: 'ledger', ledgerScope, limitUsd, spentUsd, exceeded: true }`.
2. **After the step** the reservation is committed with the step's actual cost (`costOf`); an
   aborted / failed step commits what usage is known (or 0) — never leaves a reservation open
   on a clean path. Reservations of a dead process expire after `reservationTtlMs` (adapter).
3. **Nested usage** (`addUsage`, summarizer, P26 judge) is recorded at the next step boundary
   and at turn end with `record` (key derived from turn + sequence, idempotent).
4. **Unpriced models**: estimate 0, actual 0, `W_MODEL_UNPRICED` (unchanged); the ledger still
   gets `record` calls of priced nested usage.
5. **Ledger errors**: `onError: 'stop'` → the turn stops with `'error'` (`EH_STORAGE`,
   `details.operation: 'budget-ledger'`) before the model call; `'continue'` → `W_BUDGET_LEDGER_FAILED`
   and the step runs unreserved. Commit/record failures after a step are warnings
   (`W_BUDGET_LEDGER_FAILED`) — the spend already happened.
6. **Composition**: the 0.4 per-turn / per-session budgets and token caps still apply; the first
   cap reached stops the turn. `W_BUDGET` `warnAt` is not evaluated for ledger scopes (limits live
   in the app's ledger; soft limits / alerts are app policy, e.g. inside its adapter).
7. **Scopes, periods, prices, limits** are never interpreted by the core: scope strings are
   opaque; `memoryBudgetLedger({ limits: Record<string, number> })` has static limits and no
   periods.

## Checklist

- [ ] ADR-0029 "Cross-session budget ledger port" (amends ADR-0016): port vs gateway, reserve /
      commit, fail closed by default, what stays app policy.
- [ ] Spec 12 §4.1 (rules 1–7) + §2 estimate helper; spec 10 §2 (`W_BUDGET` details,
      `W_BUDGET_LEDGER_FAILED`), §1 (`EH_STORAGE` operation); spec 01 §1 config summary; spec 06
      §5.3 (summarizer usage recorded).
- [ ] Conformance first-class: `budgetLedgerConformance(factory)` — all-or-nothing reserve over
      several scopes; **concurrent** reserves (100 parallel) never exceed a limit; commit
      replaces the reservation (higher and lower); idempotent commit / release / record;
      reservation expiry; `check` sums; unknown scopes have no limit. `memoryBudgetLedger()`
      passes it.
- [ ] Implement estimate helper, reserve before calls, commit after steps (incl. abort /
      provider error / timeout paths), record nested usage, error policy.
- [ ] Tests: two sessions sharing one ledger scope stop at the limit with at most one estimate of
      overshoot each; first-call refusal → `'cost-cap'`, 0 steps, nothing persisted beyond the
      0.4 rules; wrap-up step reserves; aborted step commits partial; ledger throwing with
      `'stop'` / `'continue'`; summarizer and `addUsage` recorded once (idempotent keys across a
      retried record); no ledger → 0.4 goldens.
- [ ] `examples/postgres-budget-ledger.ts` (tables `eh_budget_scope (scope, period_start,
      limit_usd, spent_usd, reserved_usd)`, monthly periods in UTC with a note on time zones,
      reservations table with expiry) conformance-tested on the CI Postgres service;
      `examples/budget-and-cost.ts` gains a memory-ledger part (in `examples.test.ts`).
- [ ] Guide `models-and-cost.md` "Budgets across sessions"; changeset; board; gate.

## Acceptance criteria

- [ ] With a shared ledger, total spend over N concurrent sessions never exceeds the limit by more
      than the sum of the in-flight estimates' errors (reservation semantics proven by the
      conformance concurrency case and an int test).
- [ ] Without `budget.ledger`, behaviour, warnings and storage are identical to 0.4.
- [ ] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New optional port `BudgetLedger` (`budget.ledger { adapter, scopes, estimate?,
  reservationTtlMs?, onError? }`), `memoryBudgetLedger()` in `eharness/storage/memory`,
  `budgetLedgerConformance` in `eharness/testing`, `estimateStepCostUsd()` helper, warning
  `W_BUDGET_LEDGER_FAILED`; ledger refusals stop with `'cost-cap'`.
- Type-level: `W_BUDGET` `details.scope` gains `'ledger'` (code matching `'turn' | 'session'`
  exhaustively must add it); `WarningCode` gains a member. No new stop reason.

## Open questions

1. **Fail closed or open** when the ledger is down. Pick: closed (`onError: 'stop'`), because a
   ledger exists to cap money; documented with the opt-out.
2. **Default estimate** when `maxOutputTokens` is unset. Pick: 4 096 output tokens; the guide
   shows a tighter custom `estimate`.
3. **Pre-turn check** separate from the first reservation? Pick: no — the first reservation is the
   check (one round trip).
4. Should the 0.4 `maxSessionUsd` be expressible as a ledger scope? Pick: no change; both exist.

## Requests to other phases

- P26: the judge reports its usage with `ctx.turn.addUsage(usage, { source: 'guard', model })`
  so it reaches the ledger through rule 3 (no direct ledger access from the plugin).
- P29: reference, results table row #3, roadmap "Budget pre-flight estimate" row partially done.

## Dependencies

None hard (wave W2, parallel with P23). Shares `src/session/turn.ts` / `src/loop/steps.ts` with
P23: keep commits small and rebase often.
