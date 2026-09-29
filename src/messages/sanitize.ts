/**
 * Wire sanitation (internal): every tool call gets a result, orphan results are removed, empty
 * messages are removed. Used by projection (spec 03 §6 step 7) and the guard (spec 06 §6 step 1).
 *
 * @see docs/specs/06-compaction.md#6-guard-always-on-not-configurable-away
 */
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai'
import { INTERRUPTED_UNKNOWN } from './texts.ts'

type ToolPart = ToolModelMessage['content'][number]
type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number]

function isEmpty(message: ModelMessage): boolean {
  return typeof message.content === 'string'
    ? message.content.length === 0
    : message.content.length === 0
}

/**
 * Sanitize a model wire:
 *
 * - a tool call without a result gets a synthesized `error-text` result (`INTERRUPTED_UNKNOWN`),
 *   appended to the tool message that follows its assistant message (or a new one) — except calls
 *   whose approved `tool-approval-response` sits in the final message of the wire (the first step
 *   of a `respond()` continuation, which AI SDK executes);
 * - a tool result (or approval response) without a matching call in the preceding assistant
 *   message is removed;
 * - empty messages are removed.
 *
 * Returns a new array; input messages are not mutated.
 */
export function sanitizeModelMessages(
  messages: readonly ModelMessage[],
  errorText: string = INTERRUPTED_UNKNOWN,
): ModelMessage[] {
  const input = messages.filter((m) => !isEmpty(m))
  const out: ModelMessage[] = []
  let i = 0
  while (i < input.length) {
    const message = input[i] as ModelMessage
    if (message.role === 'tool') {
      // tool message without a preceding assistant message: every result is an orphan
      i++
      continue
    }
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      out.push(message)
      i++
      continue
    }

    // group = assistant message + the tool messages that directly follow it
    const calls = new Map<string, string>() // toolCallId -> toolName
    const approvalToCall = new Map<string, string>() // approvalId -> toolCallId
    const answered = new Set<string>()
    const assistantContent: AssistantPart[] = []
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        calls.set(part.toolCallId, part.toolName)
      } else if (part.type === 'tool-approval-request') {
        approvalToCall.set(part.approvalId, part.toolCallId)
      }
    }
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        // provider-executed results live in the assistant message
        if (!calls.has(part.toolCallId) || answered.has(part.toolCallId)) continue
        answered.add(part.toolCallId)
      }
      assistantContent.push(part)
    }
    out.push(
      assistantContent.length === message.content.length
        ? message
        : { ...message, content: assistantContent },
    )
    i++

    const toolMessages: ToolModelMessage[] = []
    /** Calls AI SDK executes from a trailing approved response (answered, but a result wins). */
    const executable = new Set<string>()
    let lastToolIndex = -1
    while (i < input.length && (input[i] as ModelMessage).role === 'tool') {
      const tool = input[i] as ToolModelMessage
      const content: ToolPart[] = []
      for (const part of tool.content) {
        if (part.type === 'tool-result') {
          if (!calls.has(part.toolCallId) || answered.has(part.toolCallId)) continue
          answered.add(part.toolCallId)
        } else if (part.type === 'tool-approval-response') {
          if (!approvalToCall.has(part.approvalId)) continue
          if (i === input.length - 1 && part.approved) {
            // trailing approval of a respond() continuation: AI SDK executes the call (unless
            // the same message already holds its result, e.g. an automatic approval)
            executable.add(approvalToCall.get(part.approvalId) as string)
          }
        }
        content.push(part)
      }
      if (content.length > 0) {
        toolMessages.push(content.length === tool.content.length ? tool : { ...tool, content })
        lastToolIndex = toolMessages.length - 1
      }
      i++
    }

    const synthesized: ToolPart[] = []
    for (const [toolCallId, toolName] of calls) {
      if (answered.has(toolCallId) || executable.has(toolCallId)) continue
      synthesized.push({
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'error-text', value: errorText },
      })
    }
    if (synthesized.length > 0) {
      if (lastToolIndex >= 0) {
        const last = toolMessages[lastToolIndex] as ToolModelMessage
        toolMessages[lastToolIndex] = { ...last, content: [...last.content, ...synthesized] }
      } else {
        toolMessages.push({ role: 'tool', content: synthesized })
      }
    }
    out.push(...toolMessages)
  }
  return out
}
