/**
 * The readable text of a turn that stopped on a budget (D15 of the e2e pass): which limit, how much
 * is spent, where to raise it. The refusal tracking and the notice plugin are `eharness/limits`.
 */
import type { BudgetRefusal } from 'eharness/limits'

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
