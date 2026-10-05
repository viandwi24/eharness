/**
 * Inbox input (de)serialization (internal): the JSON form of a normalized input, and the holder's
 * re-validation of it (its own `inputFiles` and `acceptClientMetadata` apply).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
import type { JSONValue, UIMessage } from 'ai'
import type { SerializedInput } from '../../agent/session-types.ts'
import type { InputFilesConfig } from '../../agent/types.ts'
import { type NormalizedInput, normalizeInput } from '../input.ts'

/** The stored form of a normalized input. */
export function toSerialized(input: NormalizedInput): SerializedInput {
  const out: SerializedInput = { parts: structuredClone(input.parts) }
  if (input.clientId !== undefined) out.clientId = input.clientId
  if (input.appMetadata !== undefined) {
    out.appMetadata = structuredClone(input.appMetadata) as Record<string, JSONValue>
  }
  return out
}

/** Normalize a stored input again (throws `EH_INVALID_INPUT`). */
export function fromSerialized(
  input: SerializedInput,
  options: { acceptClientMetadata: boolean; files: InputFilesConfig | undefined },
): NormalizedInput {
  const message: UIMessage = {
    id: input.clientId ?? '',
    role: 'user',
    parts: structuredClone(input.parts ?? []),
    ...(input.appMetadata === undefined ? {} : { metadata: structuredClone(input.appMetadata) }),
  }
  return normalizeInput(message, options)
}
