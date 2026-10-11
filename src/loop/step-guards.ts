import type { LanguageModelUsage } from 'ai'
import { runHook } from '../internal/hook-run.ts'
import { abortReason } from '../internal/util.ts'
import type { StopReason } from '../messages/types.ts'
import type { LoopResult, StepsCtx } from './step-ctx.ts'
import { emptyUsage, totalUsageOf } from './usage.ts'

export function runBounded<T>(
  st: StepsCtx,
  hook: string,
  owner: string,
  call: () => T | Promise<T>,
): Promise<T> {
  return runHook(call, { hook, owner, timeoutMs: st.hookTimeoutMs, signal: st.input.signal })
}

/** The budget that is used up, checking the warn threshold on the way (spec 12 §4). */
export function overBudget(st: StepsCtx): 'turn' | 'session' | undefined {
  const budget = st.input.budget
  if (budget === undefined) return undefined
  const turn = st.input.usage.costUsd ?? 0
  const checks: Array<['turn' | 'session', number | undefined, number]> = [
    ['turn', budget.maxTurnUsd, turn],
    ['session', budget.maxSessionUsd, (st.input.sessionCostBefore ?? 0) + turn],
  ]
  let over: 'turn' | 'session' | undefined
  for (const [scope, limit, spent] of checks) {
    if (limit === undefined || !(limit >= 0)) continue
    const exceeded = spent >= limit
    const warnAt = budget.warnAt ?? 0.8
    const key = `${scope}:${exceeded ? 'exceeded' : 'warn'}`
    if ((exceeded || spent >= limit * warnAt) && !st.budgetWarned.has(key)) {
      st.budgetWarned.add(key)
      st.rt.warn(
        {
          code: 'W_BUDGET',
          message: exceeded
            ? `The ${scope} budget of $${limit} is used up ($${spent.toFixed(4)}); the turn stops.`
            : `The ${scope} budget of $${limit} is ${Math.round((spent / limit) * 100)}% used.`,
          details: { scope, limitUsd: limit, spentUsd: spent, exceeded },
        },
        `${st.info.id}:${key}`,
      )
    }
    if (exceeded && over === undefined) over = scope
  }
  return over
}

/** Record a failed answer; the turn stops `'output-invalid'` once retries are used up. */
export function failAnswer(st: StepsCtx, error: string): void {
  if (st.output === undefined) return
  st.output.state.failures++
  st.output.state.lastError = error
}

export function outputExhausted(st: StepsCtx): boolean {
  return st.output !== undefined && st.output.state.failures > st.output.maxRetries
}

export function outputInvalid(st: StepsCtx): StopReason {
  st.rt.warn(
    {
      code: 'W_OUTPUT_INVALID',
      message: `No valid final answer after ${st.output?.state.failures ?? 0} attempt(s); the turn stops with 'output-invalid'.`,
      details: {
        attempts: st.output?.state.failures ?? 0,
        lastError: st.output?.state.lastError ?? '',
      },
    },
    st.info.id,
  )
  return 'output-invalid'
}

/** No step reminder, input delivery or moving rewrite before the first call of a continuation. */
export function firstOfContinuation(st: StepsCtx): boolean {
  return st.input.continuation === true && st.stepIndex === 0
}

export function aborted(st: StepsCtx): LoopResult {
  if (st.external.length > 0) st.input.inbox?.unshift(st.external)
  st.external = []
  return {
    stop: st.input.timedOut() ? 'timeout' : 'aborted',
    steps: st.stepIndex,
    model: st.model,
    abortReason: st.input.timedOut() ? 'timeout' : abortReason(st.input.signal),
  }
}

export function totalUsage(_st: StepsCtx): LanguageModelUsage {
  return totalUsageOf(emptyUsage())
}
