/**
 * Token usage totals of a turn (internal): accumulation of step usage and `addUsage()` contributions.
 */
import type { LanguageModelUsage } from 'ai'
import type { AddUsageInput, PlainUsage } from '../plugin/types.ts'

/** Token usage of a turn, including `addUsage()` contributions. */
export interface UsageTotals {
  input: number
  output: number
  total: number
  reasoning: number
  cacheRead: number | undefined
  cacheWrite: number | undefined
  nestedInput: number
  nestedOutput: number
  nestedTotal: number
  /** Estimated USD of the priced contributions; `undefined` until one was priced. */
  costUsd: number | undefined
  /** Some contribution had no known price. */
  unpriced: boolean
}

/** Empty usage totals. */
export function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    total: 0,
    reasoning: 0,
    cacheRead: undefined,
    cacheWrite: undefined,
    nestedInput: 0,
    nestedOutput: 0,
    nestedTotal: 0,
    costUsd: undefined,
    unpriced: false,
  }
}

/**
 * AI SDK usage from either accepted shape of `TurnInfo.addUsage`: AI SDK's `LanguageModelUsage`
 * (returned as is) or plain token counts (`TurnResult['usage']`).
 */
export function normalizeUsage(input: AddUsageInput): LanguageModelUsage {
  if ('inputTokenDetails' in input && 'outputTokenDetails' in input) return input
  const plain = input as PlainUsage
  const inputTokens = plain.inputTokens
  const outputTokens = plain.outputTokens
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: plain.cachedInputTokens,
      cacheWriteTokens: plain.cacheWriteTokens,
    },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: plain.reasoningTokens },
    totalTokens: plain.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  }
}

/** Add AI SDK usage to totals (`nested` for `addUsage()`); `costUsd` undefined = unpriced. */
export function addUsage(
  totals: UsageTotals,
  usage: LanguageModelUsage,
  nested = false,
  costUsd?: number,
): void {
  if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) {
    totals.costUsd = (totals.costUsd ?? 0) + costUsd
  } else {
    totals.unpriced = true
  }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const total = usage.totalTokens ?? input + output
  if (nested) {
    totals.nestedInput += input
    totals.nestedOutput += output
    totals.nestedTotal += total
    return
  }
  totals.input += input
  totals.output += output
  totals.total += total
  totals.reasoning += usage.outputTokenDetails?.reasoningTokens ?? 0
  const read = usage.inputTokenDetails?.cacheReadTokens
  const write = usage.inputTokenDetails?.cacheWriteTokens
  if (read !== undefined) totals.cacheRead = (totals.cacheRead ?? 0) + read
  if (write !== undefined) totals.cacheWrite = (totals.cacheWrite ?? 0) + write
}

export function totalUsageOf(totals: UsageTotals): LanguageModelUsage {
  return {
    inputTokens: totals.input + totals.nestedInput,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
    },
    outputTokens: totals.output + totals.nestedOutput,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: totals.reasoning },
    totalTokens: totals.total + totals.nestedTotal,
  }
}
