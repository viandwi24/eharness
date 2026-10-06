/**
 * The restricted transcript of the `tool.approve` event (spec 11 §3.4): user messages and tool
 * calls only, built from the model wire AI SDK passes to the approval function. Tool outputs,
 * assistant text, reasoning, system messages, reminders, kind projections and projected data
 * parts are left out, so a prompt injection in a tool result cannot reach a judge reading it.
 * Limits: user text is identified by the prefixes the core writes (a person typing one of them
 * hides that text from the judge only) and kind projections are identified by the core's tag; text
 * an application projects into a user message by itself (e.g. a group history block, spec 16)
 * is indistinguishable from a person's text and does appear as user text.
 *
 * @see docs/specs/11-interaction.md#34-restricted-transcript
 * @see docs/specs/15-guard-plugin.md
 */
import type { ModelMessage } from 'ai'

/**
 * One entry of the restricted transcript (`tool.approve` event, spec 11 §3.4): a user message's
 * text (file parts as `[file: name, mediaType]`) or a tool call the agent made, oldest first.
 */
export type GuardTranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'tool-call'; toolName: string; input: unknown }

/**
 * Prefixes of user-role text the core (not a person) writes: reminders, projected data parts
 * (`model: 'text'`), compaction summaries and events. Such text parts are skipped.
 */
const CORE_PREFIXES = [
  '<system-reminder>',
  '<data type="',
  '<conversation-summary>',
  '<event name="',
]

function fileLabel(part: { filename?: unknown; mediaType?: unknown }): string {
  const name = typeof part.filename === 'string' && part.filename !== '' ? part.filename : 'unnamed'
  const type =
    typeof part.mediaType === 'string' && part.mediaType !== '' ? part.mediaType : 'unknown'
  return `[file: ${name}, ${type}]`
}

/**
 * Build the restricted transcript from a model wire (pure, never throws, returns fresh copies).
 *
 * - `user` messages with part arrays: `text` parts (without core-written prefixes) and
 *   `file` / `image` parts as labels, joined by a newline; one entry per message. User messages
 *   with string content, and messages the core tagged as kind projections
 *   (`providerOptions.eharness.core`), are core-written and skipped.
 * - `assistant` messages: only `tool-call` parts (`toolName`, a copy of `input`); the call with
 *   `excludeToolCallId` (the call under review) is left out.
 * - Everything else (`system`, `tool`, assistant text, reasoning, approval parts) is dropped.
 */
export function buildTranscript(
  messages: readonly ModelMessage[] | undefined,
  excludeToolCallId?: string,
): GuardTranscriptEntry[] {
  const out: GuardTranscriptEntry[] = []
  if (!Array.isArray(messages)) return out
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    if (message.role === 'user') {
      if (!Array.isArray(message.content)) continue
      // kind projections the core tagged (`providerOptions.eharness.core`) are not a person's text
      const tag = (message.providerOptions as { eharness?: { core?: unknown } } | undefined)
        ?.eharness
      if (tag?.core === true) continue
      const texts: string[] = []
      for (const part of message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (typeof part !== 'object' || part === null) continue
        if (part.type === 'text' && typeof part.text === 'string') {
          const text = part.text
          if (CORE_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix))) continue
          if (text.trim() !== '') texts.push(text)
        } else if (part.type === 'file' || part.type === 'image') {
          texts.push(fileLabel(part as { filename?: unknown; mediaType?: unknown }))
        }
      }
      if (texts.length > 0) out.push({ role: 'user', text: texts.join('\n') })
      continue
    }
    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as Array<{
        type?: unknown
        toolName?: unknown
        toolCallId?: unknown
        input?: unknown
      }>) {
        if (typeof part !== 'object' || part === null || part.type !== 'tool-call') continue
        if (typeof part.toolName !== 'string') continue
        if (excludeToolCallId !== undefined && part.toolCallId === excludeToolCallId) continue
        out.push({ role: 'tool-call', toolName: part.toolName, input: copy(part.input) })
      }
    }
  }
  return out
}

function copy(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return undefined
  }
}
