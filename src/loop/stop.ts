/**
 * Continue-vs-stop decision after a step (internal, pure).
 *
 * @see docs/specs/05-session-and-storage.md#31-continue-vs-stop-after-a-step-normative
 */
import type { FinishReason, ModelMessage } from 'ai'
import type { PendingState, StopReason } from '../messages/types.ts'
import type { ToolTraits } from '../registry/risk.ts'

/** Facts about one finished step. */
export interface StepFacts {
  /** `undefined` when the provider call failed before streaming. */
  finishReason: FinishReason | undefined
  /** The step's stream contained an `error` chunk. */
  sawError: boolean
  /** Calls waiting for `respond()` (rule 4), if any. */
  pending: PendingState | undefined
  /** `plugin:<plugin>:<reason>` from a `step.end` hook (rule 5). */
  hookStop: string | undefined
  /** Steps run in this turn so far (including this one). */
  stepCount: number
  /** Step budget of the turn (`maxSteps`, extended by `turn.beforeEnd`). */
  budget: number
  /** Cumulative output tokens of the turn (incl. `addUsage`). */
  outputTokens: number
  /** `loop.maxTurnOutputTokens`. */
  maxOutputTokens: number
}

/**
 * Evaluate the stop rules in order; the first match decides. `undefined` = continue (finish
 * reason `tool-calls` and every call has a result).
 */
export function decideStop(facts: StepFacts): StopReason | undefined {
  const reason = facts.finishReason
  if (facts.sawError || reason === 'error' || reason === undefined) return 'error'
  if (reason === 'length' || reason === 'content-filter') return reason
  if (reason === 'stop' || reason === 'other') return 'complete'
  if (facts.pending !== undefined) return 'tool-pending'
  if (facts.hookStop !== undefined) return facts.hookStop as StopReason
  if (facts.stepCount >= facts.budget) return 'max-steps'
  if (facts.outputTokens > facts.maxOutputTokens) return 'cost-cap'
  return undefined
}

/**
 * Calls of a step that wait for `respond()` (spec 11 §2): approval requested by the
 * user-approval path (no result yet), or a call of a client tool (no `execute`) without output.
 */
export function findPending(
  messageId: string,
  response: readonly ModelMessage[],
  clientTools: ReadonlySet<string>,
  traitsOfTool?: (toolName: string) => Pick<ToolTraits, 'risk' | 'idempotent'>,
): PendingState | undefined {
  const calls = new Map<string, string>()
  const inputs = new Map<string, unknown>()
  const results = new Set<string>()
  const approvals = new Map<string, string>() // toolCallId -> approvalId
  for (const message of response) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call' && part.providerExecuted !== true) {
        calls.set(part.toolCallId, part.toolName)
        inputs.set(part.toolCallId, part.input)
      } else if (part.type === 'tool-result') {
        results.add(part.toolCallId)
      } else if (part.type === 'tool-approval-request') {
        approvals.set(part.toolCallId, part.approvalId)
      }
    }
  }
  const pending: PendingState = { messageId, approvals: [], clientTools: [] }
  for (const [toolCallId, toolName] of calls) {
    if (results.has(toolCallId)) continue
    const approvalId = approvals.get(toolCallId)
    if (approvalId !== undefined) {
      const { risk, idempotent } = traitsOfTool?.(toolName) ?? {}
      pending.approvals.push({
        approvalId,
        toolCallId,
        toolName,
        input: inputs.get(toolCallId),
        ...(risk === undefined ? {} : { risk }),
        ...(idempotent === undefined ? {} : { idempotent }),
      })
    } else if (clientTools.has(toolName)) pending.clientTools.push({ toolCallId, toolName })
  }
  return pending.approvals.length + pending.clientTools.length > 0 ? pending : undefined
}
