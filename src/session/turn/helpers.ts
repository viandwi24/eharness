/**
 * Small pure helpers of the turn lifecycle (internal).
 */
import { asSchema } from 'ai'
import type { BudgetConfig } from '../../agent/types.ts'
import type { HarnessErrorCode } from '../../codes.ts'
import type { BudgetOverrun } from '../../compaction/compact.ts'
import { HarnessError } from '../../errors.ts'
import { toolSearchNames } from '../../loop/step-events.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import type { TurnError } from '../../stream/describe-error.ts'

/** The stored / streamed error of `metadata.eharness.error` (`details` stay in `run.result`). */
export function metaError(
  error: TurnError | undefined,
): { code: HarnessErrorCode; message: string } | undefined {
  if (error === undefined) return undefined
  const { details: _details, ...rest } = error
  return rest
}

export function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v
  return out as T
}

/** Seed tool-search discoveries from the loaded context (spec 02 §3.3). */
export function seedDiscovered(view: readonly HarnessUIMessage[]): Set<string> {
  const out = new Set<string>()
  for (const message of view) {
    for (const part of message.parts) {
      if (part.type !== 'tool-tool_search') continue
      const tool = part as { state?: string; output?: unknown }
      if (tool.state === 'output-available')
        for (const n of toolSearchNames(tool.output)) out.add(n)
    }
  }
  return out
}

/**
 * The used-up USD budget (spent ≥ limit), turn first (spec 12 §4); `undefined` when none is.
 * `sessionCost` is the cost of the session's earlier turns.
 */
export function budgetOverrun(
  budget: BudgetConfig | undefined,
  turnCost: number,
  sessionCost: number,
): BudgetOverrun | undefined {
  if (budget === undefined) return undefined
  const checks: Array<['turn' | 'session', number | undefined, number]> = [
    ['turn', budget.maxTurnUsd, turnCost],
    ['session', budget.maxSessionUsd, sessionCost + turnCost],
  ]
  for (const [scope, limitUsd, spentUsd] of checks) {
    if (limitUsd === undefined || !(limitUsd >= 0)) continue
    if (spentUsd >= limitUsd) return { scope, limitUsd, spentUsd }
  }
  return undefined
}

/** Validate a value against a schema; returns the (possibly transformed) value. */
export async function validateWith(
  schema: unknown,
  value: unknown,
  what: string,
): Promise<unknown> {
  const validate = asSchema(schema as Parameters<typeof asSchema>[0]).validate
  if (validate === undefined) return value
  const result = await validate(value)
  if (result.success) return result.value
  throw new HarnessError('EH_INVALID_INPUT', `${what} is invalid: ${result.error.message}`, {
    cause: result.error,
  })
}
