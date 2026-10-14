/**
 * `budgetNotice` plugin: when the budget ledger refuses a reservation the library stops the turn
 * with `cost-cap` before the model call and stores an empty assistant message, so a chat shows
 * nothing. `trackRefusals` remembers which scope refused; the plugin turns the refusal into a
 * readable `eh.notice` stored in the session.
 *
 * @see docs/specs/33-limits.md
 */
import { type BudgetLedger, definePlugin, type HarnessPlugin } from '../index.ts'

/** The scope that refused the last reservation of a session. */
export interface BudgetRefusal {
  scope: string
  limitUsd: number
  spentUsd: number
}

export interface RefusalTracker {
  /** The ledger to give the agent: the same ledger, remembering what it refused. */
  ledger: BudgetLedger
  /** The last refusal of a session (and forget it). */
  take(sessionId: string): BudgetRefusal | undefined
  peek(sessionId: string): BudgetRefusal | undefined
}

/** `key` of a reservation is `${sessionId}:${turnId}:${stepIndex}` (the session id may have colons). */
const sessionOfKey = (key: string): string => key.split(':').slice(0, -2).join(':')

/** Wrap a ledger so the last refusal of every session can be read (bounded to 500 sessions). */
export function trackRefusals(inner: BudgetLedger): RefusalTracker {
  const last = new Map<string, BudgetRefusal>()
  const ledger: BudgetLedger = {
    reserve: async (req) => {
      const result = await inner.reserve(req)
      const sessionId = sessionOfKey(req.key)
      if (result.ok) last.delete(sessionId)
      else {
        last.set(sessionId, {
          scope: result.scope,
          limitUsd: result.limitUsd,
          spentUsd: result.spentUsd,
        })
        if (last.size > 500) last.delete(last.keys().next().value as string)
      }
      return result
    },
    commit: (id, usd) => inner.commit(id, usd),
    release: (id) => inner.release(id),
    record: (req) => inner.record(req),
    check: (scopes) => inner.check(scopes),
  }
  return {
    ledger,
    take(sessionId) {
      const found = last.get(sessionId)
      last.delete(sessionId)
      return found
    },
    peek: (sessionId) => last.get(sessionId),
  }
}

const dollars = (n: number): string => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`

/** The default notice text: which scope, how much is used, what to do. */
export function defaultBudgetText(refusal: BudgetRefusal | undefined): string {
  if (refusal === undefined) {
    return 'This turn stopped because a spending limit was reached. Raise the budget or wait for it to reset, then send your message again.'
  }
  return `A spending limit was reached (${refusal.scope}: ${dollars(refusal.spentUsd)} of ${dollars(refusal.limitUsd)} used or reserved). Raise the limit or wait for it to reset, then send your message again.`
}

export interface BudgetNoticeOptions {
  /** The tracker whose `ledger` the agent uses; without it the notice is generic. */
  refusals?: RefusalTracker
  /** Notice text; return an empty string for no notice (e.g. not a chat session). */
  text?: (refusal: BudgetRefusal | undefined, sessionId: string) => string
}

/** Stores a readable `eh.notice` when a turn stops with `cost-cap`. */
export function budgetNotice(options: BudgetNoticeOptions = {}): HarnessPlugin<'budget-notice'> {
  return definePlugin({
    name: 'budget-notice',
    setup: () => ({
      hooks: {
        'turn.end': async (ctx, e: { stop: string }): Promise<void> => {
          if (e.stop !== 'cost-cap') return
          const refusal = options.refusals?.take(ctx.session.id)
          const message = (options.text ?? defaultBudgetText)(refusal, ctx.session.id)
          if (message === '') return
          try {
            await ctx.session.inject('eh.notice', {
              level: 'warning',
              code: 'EH_COST_CAP',
              message,
            })
          } catch (error) {
            ctx.log.warn(`budget notice not stored: ${String(error)}`)
          }
        },
      },
    }),
  })
}
