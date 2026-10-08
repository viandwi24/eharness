/**
 * Continue-vs-stop decision after a step (internal, pure).
 *
 * @see docs/specs/05-session-and-storage.md#31-continue-vs-stop-after-a-step-normative
 */
import type { FinishReason, ModelMessage } from 'ai'
import { WAIT_TIMED_OUT } from '../messages/texts.ts'
import type { PendingState, StopReason } from '../messages/types.ts'
import type { ToolTraits } from '../registry/risk.ts'
import { clientToolEntry } from '../session/interaction/pending.ts'

/** The wait id of an external call: stable per tool call (spec 11 §4.2 rule 1). */
export function waitIdOf(toolCallId: string): string {
  return `w_${toolCallId}`
}

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
 * user-approval path (no result yet; an automatically `approved` call has no entry), a call of a client tool (no `execute`) without output, or
 * a call of an external tool (`externalTool()`, spec 11 §4.2: an entry of `externals` that
 * `armExternals` completes with the tool defaults; `start` runs after the commit). The state is written as version 2.
 */
export function findPending(
  messageId: string,
  response: readonly ModelMessage[],
  clientTools: ReadonlySet<string>,
  traitsOfTool?: (toolName: string) => Pick<ToolTraits, 'risk' | 'idempotent'>,
  externalTools?: ReadonlySet<string>,
): PendingState | undefined {
  const calls = new Map<string, string>()
  const inputs = new Map<string, unknown>()
  const results = new Set<string>()
  const approvals = new Map<string, string>() // toolCallId -> approvalId
  const granted = new Set<string>() // approvalIds the AI SDK answered itself (`approved` status)
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
      } else if (part.type === 'tool-approval-response' && part.approved) {
        granted.add(part.approvalId)
      }
    }
  }
  const pending: PendingState = { v: 2, messageId, approvals: [], clientTools: [] }
  for (const [toolCallId, toolName] of calls) {
    if (results.has(toolCallId)) continue
    const approvalId = approvals.get(toolCallId)
    // an `approved` status answers the request in the same step: no human decision is waiting
    // (a tool without `execute` then parks as its normal kind, spec 11 §3)
    if (approvalId !== undefined && !granted.has(approvalId)) {
      const { risk, idempotent } = traitsOfTool?.(toolName) ?? {}
      pending.approvals.push({
        approvalId,
        toolCallId,
        toolName,
        input: inputs.get(toolCallId),
        ...(risk === undefined ? {} : { risk }),
        ...(idempotent === undefined ? {} : { idempotent }),
      })
    } else if (externalTools?.has(toolName) === true) {
      pending.externals ??= []
      pending.externals.push({
        waitId: waitIdOf(toolCallId),
        toolCallId,
        toolName,
        onTimeout: { errorText: WAIT_TIMED_OUT },
      })
    } else if (clientTools.has(toolName)) {
      pending.clientTools.push(clientToolEntry(toolCallId, toolName, inputs.get(toolCallId)))
    }
  }
  return pending.approvals.length + pending.clientTools.length + (pending.externals?.length ?? 0) >
    0
    ? pending
    : undefined
}
