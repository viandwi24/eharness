/**
 * The `budget.ledger` of one turn (internal): reserve before every model call, commit after the
 * step, record nested usage at step boundaries and at the end, error policy (spec 12 §4.1).
 *
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
import type { LanguageModel } from 'ai'
import type { BudgetLedgerConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { DEFAULT_ESTIMATE_OUTPUT_TOKENS, estimateStepCostUsd } from '../models/cost.ts'
import type { ModelCatalog } from '../models/types.ts'
import type { HarnessContext } from '../plugin/types.ts'

/** Default reservation expiry without `reservationTtlMs` and `loop.turnTimeoutMs`. */
export const DEFAULT_RESERVATION_TTL_MS = 600_000

/** Decision before a model call. */
export type LedgerDecision =
  | { ok: true }
  | { ok: false; stop: 'cost-cap' }
  | {
      ok: false
      stop: 'error'
      error: { code: 'EH_STORAGE'; message: string; details: Record<string, unknown> }
    }

/** The ledger of one running turn. */
export interface TurnLedger {
  /**
   * Before a model call: record waiting nested usage, then reserve the step's estimate. A retry of
   * the same step (overflow recovery, degraded file) keeps the open reservation.
   */
  beforeCall(args: {
    stepIndex: number
    model: LanguageModel
    contextTokens: number
    maxOutputTokens: number | undefined
  }): Promise<LedgerDecision>
  /** After the step: commit the open reservation with the actual cost (0 when unknown). */
  afterCall(actualUsd: number | undefined): Promise<void>
  /** A priced nested contribution (`addUsage`, summarizer, flush); recorded at the next boundary. */
  nested(costUsd: number): void
  /** End of the turn: release an open reservation, record waiting nested usage. Never throws. */
  end(): Promise<void>
}

/** Create the ledger of one turn. */
export function createTurnLedger(args: {
  config: BudgetLedgerConfig
  models: ModelCatalog | undefined
  sessionId: string
  turnId: string
  ttlMs: number
  ctx: () => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
}): TurnLedger {
  const { config, sessionId, turnId } = args
  const adapter = config.adapter
  const failClosed = config.onError !== 'continue'
  let scopes: string[] | undefined
  /** `scopes` threw under `onError: 'continue'`: the turn runs without the ledger. */
  let disabled = false
  let open: { id: string; stepIndex: number } | undefined
  let seq = 0
  /** Priced nested contributions not recorded yet, in order. */
  const waiting: Array<{ key: string; amountUsd: number }> = []

  const failed = (operation: string, error: unknown, extra: Record<string, unknown> = {}) => {
    args.warn(
      {
        code: 'W_BUDGET_LEDGER_FAILED',
        message: `The budget ledger failed (${operation}): ${errorText(error)}`,
        details: { operation, ...extra },
      },
      `${turnId}:${operation}`,
    )
  }
  const stopError = (operation: string, error: unknown): LedgerDecision => ({
    ok: false,
    stop: 'error',
    error: {
      code: 'EH_STORAGE',
      message: `The budget ledger failed (${operation}): ${errorText(error)}`,
      details: { operation: 'budget-ledger', call: operation },
    },
  })

  /** Resolve the scopes once per turn; `undefined` when the ledger is off for this turn. */
  const resolve = async (): Promise<string[] | LedgerDecision | undefined> => {
    if (disabled) return undefined
    if (scopes !== undefined) return scopes
    try {
      const list = await config.scopes(args.ctx())
      scopes = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []
      return scopes
    } catch (error) {
      if (failClosed) return stopError('scopes', error)
      disabled = true
      failed('scopes', error)
      return undefined
    }
  }

  /** Commits that failed: retried (commit is idempotent) at the next boundary, then recorded. */
  const uncommitted: Array<{ id: string; amountUsd: number }> = []
  const commitQueued = async (): Promise<void> => {
    while (uncommitted.length > 0) {
      const item = uncommitted[0] as { id: string; amountUsd: number }
      try {
        await adapter.commit(item.id, item.amountUsd)
      } catch (error) {
        failed('commit', error, { reservationId: item.id })
        return
      }
      uncommitted.shift()
    }
  }

  /** Record waiting nested usage; a failed record stays queued (same key) for the next try. */
  const flush = async (list: string[]): Promise<void> => {
    while (waiting.length > 0) {
      const item = waiting[0] as { key: string; amountUsd: number }
      try {
        await adapter.record({ scopes: list, amountUsd: item.amountUsd, key: item.key })
      } catch (error) {
        failed('record', error, { key: item.key })
        return
      }
      waiting.shift()
    }
  }

  return {
    async beforeCall({ stepIndex, model, contextTokens, maxOutputTokens }) {
      const list = await resolve()
      if (list === undefined) return { ok: true }
      if (!Array.isArray(list)) return list
      if (list.length === 0) return { ok: true }
      await commitQueued()
      await flush(list)
      if (open !== undefined && open.stepIndex === stepIndex) return { ok: true }
      const output = maxOutputTokens ?? DEFAULT_ESTIMATE_OUTPUT_TOKENS
      let amountUsd: number
      try {
        amountUsd =
          config.estimate === undefined
            ? (estimateStepCostUsd({
                models: args.models,
                model,
                contextTokens,
                maxOutputTokens: output,
              }) ?? 0)
            : config.estimate({ ctx: args.ctx(), model, contextTokens, maxOutputTokens: output })
      } catch (error) {
        if (failClosed) return stopError('estimate', error)
        failed('estimate', error)
        return { ok: true }
      }
      if (!(Number.isFinite(amountUsd) && amountUsd >= 0)) amountUsd = 0
      let result: Awaited<ReturnType<typeof adapter.reserve>>
      try {
        result = await adapter.reserve({
          scopes: list,
          amountUsd,
          ttlMs: args.ttlMs,
          key: `${sessionId}:${turnId}:${stepIndex}`,
        })
      } catch (error) {
        if (failClosed) return stopError('reserve', error)
        failed('reserve', error)
        return { ok: true }
      }
      if (result.ok) {
        open = { id: result.reservationId, stepIndex }
        return { ok: true }
      }
      args.warn(
        {
          code: 'W_BUDGET',
          message: `The ledger budget of '${result.scope}' ($${result.limitUsd}) cannot take the next step ($${result.spentUsd.toFixed(4)} spent or reserved); the turn stops.`,
          details: {
            scope: 'ledger',
            ledgerScope: result.scope,
            limitUsd: result.limitUsd,
            spentUsd: result.spentUsd,
            exceeded: true,
          },
        },
        `${turnId}:ledger:exceeded`,
      )
      return { ok: false, stop: 'cost-cap' }
    },
    async afterCall(actualUsd) {
      const reservation = open
      open = undefined
      if (reservation === undefined) return
      const amount = actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd >= 0
      uncommitted.push({ id: reservation.id, amountUsd: amount ? (actualUsd as number) : 0 })
      await commitQueued()
    },
    nested(costUsd) {
      if (disabled || !(Number.isFinite(costUsd) && costUsd > 0)) return
      waiting.push({ key: `${sessionId}:${turnId}:usage:${seq++}`, amountUsd: costUsd })
    },
    async end() {
      const reservation = open
      open = undefined
      if (reservation !== undefined) {
        try {
          await adapter.release(reservation.id)
        } catch (error) {
          failed('release', error, { reservationId: reservation.id })
        }
      }
      await commitQueued()
      if (uncommitted.length > 0 && Array.isArray(scopes)) {
        // still failing: charge the spend once per reservation (the hold expires on its own)
        for (const item of uncommitted) {
          try {
            await adapter.record({
              scopes,
              amountUsd: item.amountUsd,
              key: `${sessionId}:${turnId}:commit:${item.id}`,
            })
          } catch (error) {
            failed('record', error, { reservationId: item.id })
          }
        }
        uncommitted.length = 0
      }
      if (waiting.length === 0) return
      const list = await resolve()
      if (Array.isArray(list)) {
        if (list.length > 0) await flush(list)
      } else if (list !== undefined) {
        // the spend already happened: a warning, never a turn error
        failed('scopes', new Error('the scopes of the turn could not be resolved'))
      }
      waiting.length = 0
    },
  }
}

/**
 * Record usage that belongs to no turn (a manual `compact()`, spec 06 §5.3) on the ledger. Failures
 * are `W_BUDGET_LEDGER_FAILED` warnings (the spend already happened). Never throws.
 */
export async function recordOutsideTurn(args: {
  config: BudgetLedgerConfig
  ctx: HarnessContext
  key: string
  amountUsd: number
  warn: (warning: HarnessWarning, key?: string) => void
}): Promise<void> {
  if (!(Number.isFinite(args.amountUsd) && args.amountUsd > 0)) return
  try {
    const scopes = await args.config.scopes(args.ctx)
    if (!Array.isArray(scopes) || scopes.length === 0) return
    await args.config.adapter.record({ scopes, amountUsd: args.amountUsd, key: args.key })
  } catch (error) {
    args.warn(
      {
        code: 'W_BUDGET_LEDGER_FAILED',
        message: `The budget ledger failed (record): ${errorText(error)}`,
        details: { operation: 'record', key: args.key },
      },
      args.key,
    )
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
