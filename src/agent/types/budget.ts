/**
 * Budget configuration and the `BudgetLedger` port.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
import type { LanguageModel } from 'ai'
import type { HarnessContext } from '../../plugin/types.ts'

/**
 * Spending limits in USD, computed from `models` pricing (estimates, spec 12 §4). Exceeding one
 * stops the turn with `'cost-cap'` after the step that crossed it.
 *
 * @see docs/specs/12-models-and-cost.md#4-budgets
 */
export interface BudgetConfig {
  /** USD per turn, incl. `ctx.turn.addUsage()` contributions. */
  maxTurnUsd?: number
  /** USD per session: all turns so far (`state.core.usage.costUsd`) plus the running turn. */
  maxSessionUsd?: number
  /** Default 0.8 — `W_BUDGET` once per turn and budget when spending reaches this share. */
  warnAt?: number
  /**
   * Cross-session limits (per user, tenant, month — whatever the app defines) enforced through a
   * {@link BudgetLedger}: every model call reserves an estimate first and commits the actual cost
   * after the step; a refused reservation stops the turn with `'cost-cap'` before the call.
   *
   * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
   */
  ledger?: BudgetLedgerConfig
}

/**
 * `budget.ledger` (spec 12 §4.1). Scopes, periods, prices and limits are app policy: the core
 * treats scope strings as opaque and never interprets them.
 *
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export interface BudgetLedgerConfig {
  adapter: BudgetLedger
  /**
   * The app-defined scopes of a turn, e.g. `[`user:${id}`, `tenant:${t}`]`; resolved once per
   * turn (before its first model call). An empty list leaves the turn unlimited by the ledger.
   */
  scopes: (ctx: HarnessContext) => string[] | Promise<string[]>
  /**
   * USD reserved before a model call. Default {@link estimateStepCostUsd}: context tokens × input
   * price + `maxOutputTokens` (default 4 096) × output price; 0 for an unpriced model.
   */
  estimate?: (e: BudgetEstimateEvent) => number
  /** Expiry of a reservation whose process died. Default `loop.turnTimeoutMs`, else 600 000. */
  reservationTtlMs?: number
  /**
   * A ledger call before a model call failed (or `scopes` threw). Default `'stop'` (fail closed):
   * the turn stops with `'error'` (`EH_STORAGE`, `details.operation: 'budget-ledger'`).
   * `'continue'`: `W_BUDGET_LEDGER_FAILED`, and the step runs unreserved.
   */
  onError?: 'stop' | 'continue'
}

/** Input of `budget.ledger.estimate`. */
export interface BudgetEstimateEvent {
  ctx: HarnessContext
  /** The step's model (after `step.prepare`). */
  model: LanguageModel
  /** Estimated input tokens of the request (instructions, tools, messages; calibrated). */
  contextTokens: number
  /** `settings.maxOutputTokens` of the step, else 4 096. */
  maxOutputTokens: number
}

/** Result of {@link BudgetLedger.reserve}. */
export type BudgetReservation =
  | { ok: true; reservationId: string }
  | {
      ok: false
      /** The first scope (in request order) that cannot take the amount. */
      scope: string
      limitUsd: number
      /** Spent plus reserved on that scope. */
      spentUsd: number
    }

/** One scope of {@link BudgetLedger.check}. */
export interface BudgetScopeStatus {
  scope: string
  /** Absent: the scope has no limit. */
  limitUsd?: number
  spentUsd: number
  /** Open (unexpired) reservations. */
  reservedUsd: number
}

/**
 * Cross-session spending ledger (spec 12 §4.1): the app's store of spent and reserved USD per
 * scope. Implementations must make `reserve` atomic over all scopes (all or nothing) and safe
 * under concurrent callers in many processes. eharness ships `inMemoryBudgetLedger()`
 * (`eharness/storage/memory`) and `budgetLedgerConformance` (`eharness/testing`).
 *
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export interface BudgetLedger {
  /**
   * Atomically reserve `amountUsd` on every scope, or nothing. A scope with a limit takes it when
   * it is not used up (spent + reserved < limit) and spent + reserved + amount ≤ limit; a scope
   * without a limit always does. `key` (`${sessionId}:${turnId}:${stepIndex}` from the core) makes
   * a retried call return the open reservation of that key instead of reserving twice. The
   * reservation expires after `ttlMs` (its amount stops counting).
   */
  reserve(req: {
    scopes: string[]
    amountUsd: number
    ttlMs: number
    key: string
  }): Promise<BudgetReservation>
  /**
   * Replace a reservation by the actual cost (higher or lower). Idempotent per reservation; an
   * expired reservation still charges `actualUsd`; unknown or released ids are ignored.
   */
  commit(reservationId: string, actualUsd: number): Promise<void>
  /** Drop a reservation without cost (the model call did not happen). Idempotent. */
  release(reservationId: string): Promise<void>
  /** Record cost without a reservation (nested usage, summarizer). Idempotent per `key`. */
  record(req: { scopes: string[]; amountUsd: number; key: string }): Promise<void>
  /**
   * Read-only status of `scopes` (for a UI or a pre-turn check): `ok` is false when a scope with
   * a limit is used up (spent + reserved ≥ limit).
   */
  check(scopes: string[]): Promise<{ ok: boolean; scopes: BudgetScopeStatus[] }>
}
