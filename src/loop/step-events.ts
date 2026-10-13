/**
 * Events and wire helpers of a step (internal): the `step.end` event, tool search discoveries,
 * response inspection and stream chunk helpers.
 */
import {
  type FinishReason,
  type InferToolOutput,
  InvalidToolInputError,
  type LanguageModelUsage,
  type ModelMessage,
  NoSuchToolError,
  type StepResult,
  type ToolSet,
  type toolSearch,
} from 'ai'
import { HarnessToolError } from '../errors.ts'
import type { StepEndEvent } from '../plugin/types.ts'

/** Output of AI SDK's `toolSearch()` tool: `{ tools: [{ name, description? }] }`. */
export type ToolSearchOutput = InferToolOutput<ReturnType<typeof toolSearch>>

export function isToolSearchOutput(value: unknown): value is ToolSearchOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { tools?: unknown }).tools)
  )
}

/**
 * Names of tools found by `tool_search` in a tool output: the raw {@link ToolSearchOutput}, or a
 * model tool result output (`{ type: 'json', value }`) wrapping it. Stored data is untrusted, so
 * the shape is checked at runtime.
 */
export function toolSearchNames(output: unknown): string[] {
  const value =
    typeof output === 'object' && output !== null && 'type' in output && 'value' in output
      ? output.value
      : output
  if (!isToolSearchOutput(value)) return []
  return value.tools
    .map((t: unknown) => (t as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string')
}

/** The output AI SDK answers a call to a tool that is not in the step's tool set with. */
function isUnavailableToolOutput(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false
  const o = output as { type?: unknown; value?: unknown }
  return (
    (o.type === 'error-text' || o.type === 'error-json') &&
    /unavailable tool|NoSuchToolError/i.test(
      typeof o.value === 'string' ? o.value : JSON.stringify(o.value),
    )
  )
}

export function collectDiscovered(response: readonly ModelMessage[], into: Set<string>): void {
  for (const message of response) {
    if (message.role !== 'tool' && message.role !== 'assistant') continue
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === 'tool_search') {
        for (const name of toolSearchNames(part.output)) into.add(name)
      }
      // a call to a deferred tool that was never loaded fails with "unavailable tool": the call
      // itself is the search, so the tool is loaded for the next step (a name that is not a
      // deferred tool of the turn is ignored by `toolsForStep`)
      if (part.type === 'tool-result' && isUnavailableToolOutput(part.output))
        into.add(part.toolName)
    }
  }
}

/**
 * The `step.end` event (exported for tests). Derived from the step's `StepResult`; when AI SDK
 * did not provide one (`step` undefined while `responseMessages` resolved), from the wire.
 */
export function stepEndEvent(
  stepIndex: number,
  finishReason: FinishReason,
  usage: LanguageModelUsage,
  totalUsage: LanguageModelUsage,
  response: readonly ModelMessage[],
  step: StepResult<ToolSet> | undefined,
): StepEndEvent {
  const toolCalls: StepEndEvent['toolCalls'] =
    step === undefined
      ? responseToolCalls(response)
      : step.toolCalls.map((call) => ({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
        }))
  // results of this step's calls, in call order (step.content lists them in completion order)
  const statuses = new Map<string, StepEndEvent['toolResults'][number]>()
  for (const part of step?.content ?? []) {
    if (part.type === 'tool-result' || part.type === 'tool-error') {
      statuses.set(part.toolCallId, {
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        status: part.type === 'tool-error' ? 'error' : 'output',
      })
    } else if (part.type === 'tool-approval-response' && !part.approved) {
      statuses.set(part.toolCall.toolCallId, {
        toolName: part.toolCall.toolName,
        toolCallId: part.toolCall.toolCallId,
        status: 'denied',
      })
    }
  }
  const toolResults: StepEndEvent['toolResults'] = [
    ...continuationResults(response, statuses),
    ...toolCalls.flatMap((call) => statuses.get(call.toolCallId) ?? []),
  ]
  const listed = new Set(toolResults.map((r) => r.toolCallId))
  for (const [id, result] of statuses) if (!listed.has(id)) toolResults.push(result)
  return {
    stepIndex,
    finishReason,
    usage,
    totalUsage,
    toolCalls,
    toolResults,
    responseMessages: [...response],
    ...(step === undefined ? {} : { step }),
  }
}

/** Tool calls on the wire of a step (fallback without a `StepResult`). */
export function responseToolCalls(response: readonly ModelMessage[]): StepEndEvent['toolCalls'] {
  const out: StepEndEvent['toolCalls'] = []
  for (const message of response) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        out.push({ toolName: part.toolName, toolCallId: part.toolCallId, input: part.input })
      }
    }
  }
  return out
}

/** Assistant text on the wire of a step (fallback without a `StepResult`). */
export function responseText(response: readonly ModelMessage[]): string {
  const texts: string[] = []
  for (const message of response) {
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') texts.push(message.content)
    else for (const part of message.content) if (part.type === 'text') texts.push(part.text)
  }
  return texts.join('')
}

/**
 * Results that are on the wire of this step but not in its `StepResult`: approved or denied tool
 * calls of a `respond()` continuation, executed by AI SDK before the model call (spec 11) — or
 * every result when there is no `StepResult`.
 */
export function continuationResults(
  response: readonly ModelMessage[],
  own: ReadonlyMap<string, unknown>,
): StepEndEvent['toolResults'] {
  const out: StepEndEvent['toolResults'] = []
  for (const message of response) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || own.has(part.toolCallId)) continue
      const type = part.output.type
      out.push({
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        status:
          type === 'execution-denied'
            ? 'denied'
            : type === 'error-text' || type === 'error-json'
              ? 'error'
              : 'output',
      })
    }
  }
  return out
}

/**
 * Errors AI SDK answers a tool call with (`error-text` = `String(error)` on the wire): a tool's
 * `execute` threw (`HarnessToolError`), the input failed the tool's schema
 * (`InvalidToolInputError`) or the tool does not exist (`NoSuchToolError`).
 */
export function isToolCallError(error: unknown): boolean {
  return (
    error instanceof HarnessToolError ||
    InvalidToolInputError.isInstance(error) ||
    NoSuchToolError.isInstance(error)
  )
}

export async function guarded<T>(value: PromiseLike<T>): Promise<T | undefined> {
  try {
    return await value
  } catch {
    return undefined
  }
}

/**
 * The `reasoning-end` chunk with the part's duration in `providerMetadata.eharness.durationMs`
 * (spec 04 §2). Merged into the existing metadata: provider keys are never overwritten.
 */
export function withReasoningDuration<C extends { type: 'reasoning-end'; id: string }>(
  chunk: C,
  started: Map<string, number>,
): C {
  const at = started.get(chunk.id)
  if (at === undefined) return chunk
  started.delete(chunk.id)
  const existing = (chunk as { providerMetadata?: Record<string, Record<string, unknown>> })
    .providerMetadata
  return {
    ...chunk,
    providerMetadata: {
      ...existing,
      eharness: { ...existing?.eharness, durationMs: Math.max(0, Date.now() - at) },
    },
  }
}
