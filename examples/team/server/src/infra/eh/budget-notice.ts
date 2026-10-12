/**
 * A turn that stops with `cost-cap` says why (D15 of the e2e pass). The library stops the turn
 * before the model call and stores an empty assistant message; a chat showed nothing and the
 * sidebar showed "(cost-cap)". The ledger refuses a reservation with the scope that could not take
 * it; this module keeps the last refusal per session, turns it into a readable text (which limit,
 * how much is spent, where to raise it) and a plugin stores it as an `eh.notice` in the chat. The
 * same text is the sidebar preview and the summary of a failed program run.
 */

import type { BudgetLedger } from 'eharness'
import { definePlugin, type HarnessPlugin } from 'eharness'

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

/** `key` of a reservation is `${sessionId}:${turnId}:${stepIndex}` (the session id has colons). */
const sessionOfKey = (key: string): string => key.split(':').slice(0, -2).join(':')

export function trackRefusals(inner: BudgetLedger): RefusalTracker {
  const last = new Map<string, BudgetRefusal>()
  const ledger: BudgetLedger = {
    ...inner,
    async reserve(req) {
      const result = await inner.reserve(req)
      const sessionId = sessionOfKey(req.key)
      if (result.ok) last.delete(sessionId)
      else {
        last.set(sessionId, {
          scope: result.scope,
          limitUsd: result.limitUsd,
          spentUsd: result.spentUsd,
        })
        // bounded: a process that runs for months must not keep every session it ever capped
        if (last.size > 500) last.delete(last.keys().next().value as string)
      }
      return result
    },
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

export interface CapNames {
  /** The name of a program, by id. */
  program(id: string): string | undefined
}

/** What the person reads when a turn stopped on a budget. Without a refusal: a generic hint. */
export function capText(refusal: BudgetRefusal | undefined, names: CapNames): string {
  if (refusal === undefined) {
    return 'This turn stopped because a spending limit was reached. Check the monthly budget in Settings > General, or the budget of the program.'
  }
  const { scope, limitUsd, spentUsd } = refusal
  const used = `${dollars(spentUsd)} of ${dollars(limitUsd)} used or reserved`
  if (scope.startsWith('workspace:')) {
    return `The monthly budget of the workspace is used up (${used} this month, UTC). Raise it in Settings > General > Monthly budget, or wait for the next month, then send your message again.`
  }
  const day = /^program:(.+):(\d{4}-\d{2}-\d{2})$/.exec(scope)
  if (day !== null) {
    const name = names.program(day[1] as string) ?? (day[1] as string)
    return `The day budget of program "${name}" is used up (${used} on ${day[2]}, UTC). Raise its per-day budget on the Programs page, or it runs again tomorrow.`
  }
  if (scope.startsWith('program-run:')) {
    return `The budget of this program run is used up (${used}). Raise the per-run budget on the Programs page; a run reserves its worst-case cost before each call, so a very small budget stops it before its first call.`
  }
  if (scope.startsWith('rehearsal:')) {
    return `The spend cap of this test run is used up (${used}). Run it again with a higher cap.`
  }
  return `A spending limit was reached (${scope}: ${used}).`
}

/** Stores the readable notice in the chat when a conversation turn stops on a budget. */
export function budgetNotice(options: {
  /** Text for a session whose turn stopped with `cost-cap`; undefined = no notice (not a chat). */
  describe(sessionId: string): string | undefined
}): HarnessPlugin<'budget-notice'> {
  return definePlugin({
    name: 'budget-notice',
    setup: () => ({
      hooks: {
        'turn.end': async (ctx, e: { stop: string }) => {
          if (e.stop !== 'cost-cap') return
          const message = options.describe(ctx.session.id)
          if (message === undefined) return
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
