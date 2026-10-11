/**
 * Small pieces of the pending-state contract shared by the loop, the session and the HTTP request
 * handler (internal): the `respond()` option of `handleChatRequest` and the stored client tool entry.
 *
 * @see docs/specs/11-interaction.md#2-pending-state
 */
import type { PendingState } from './types.ts'

/**
 * Internal `respond()` option set by `handleChatRequest`: answers that are not pending are
 * ignored instead of rejected (spec 11 §7). `Symbol.for` so that package copies agree.
 */
export const RESPOND_IGNORE_UNKNOWN: unique symbol = Symbol.for('eharness.respond.ignoreUnknown')

/** Largest stored `input` of a pending client tool call (UTF-8 bytes of its JSON). */
export const MAX_PENDING_INPUT_BYTES: number = 16 * 1024

/**
 * The pending entry of a client tool call, with its `input` unless the JSON is larger than 16 KB
 * (then `inputTruncated: true`; spec 11 §2). An input that is not JSON-serialisable is left out.
 */
export function clientToolEntry(
  toolCallId: string,
  toolName: string,
  input: unknown,
): PendingState['clientTools'][number] {
  const entry: PendingState['clientTools'][number] = { toolCallId, toolName }
  if (input === undefined) return entry
  try {
    const json = JSON.stringify(input)
    if (json === undefined) return entry
    if (new TextEncoder().encode(json).length > MAX_PENDING_INPUT_BYTES) {
      entry.inputTruncated = true
    } else {
      entry.input = JSON.parse(json)
    }
  } catch {
    entry.inputTruncated = true
  }
  return entry
}
