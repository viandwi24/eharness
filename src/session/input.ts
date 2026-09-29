/**
 * Input normalization: clients never add tool parts, data parts or kinds, and never choose ids
 * or `metadata.eharness` (internal).
 *
 * @see docs/specs/05-session-and-storage.md#3-turn-lifecycle-normative-order
 */
import type { FileUIPart, TextUIPart } from 'ai'
import type { SendInput } from '../agent/session-types.ts'
import { HarnessError } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'

/** The accepted user content of one input. */
export interface NormalizedInput {
  parts: Array<TextUIPart | FileUIPart>
  /** Id the client used (kept as `metadata.eharness.clientId`). */
  clientId?: string
  /** App metadata keys (only with `acceptClientMetadata`). */
  appMetadata?: Record<string, unknown>
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new HarnessError(
    'EH_INVALID_INPUT',
    message,
    details === undefined ? undefined : { details },
  )
}

function normalizeFile(part: unknown, where: string): FileUIPart {
  const file = part as Partial<FileUIPart> | null
  if (
    typeof file !== 'object' ||
    file === null ||
    file.type !== 'file' ||
    typeof file.mediaType !== 'string' ||
    typeof file.url !== 'string'
  ) {
    invalid(`${where}: a file part needs a string mediaType and url.`)
  }
  return {
    type: 'file',
    mediaType: file.mediaType,
    url: file.url,
    ...(typeof file.filename === 'string' ? { filename: file.filename } : {}),
  }
}

/**
 * Normalize `send()` input: role `user`, only `text` and `file` parts (any other part type →
 * `EH_INVALID_INPUT`), client `metadata.eharness` discarded, client id kept as `clientId`, other
 * client metadata keys kept only with `acceptClientMetadata`.
 */
export function normalizeInput(
  input: SendInput,
  options: { acceptClientMetadata?: boolean } = {},
): NormalizedInput {
  if (typeof input === 'string') {
    if (input.length === 0) invalid('Input text is empty.')
    return { parts: [{ type: 'text', text: input }] }
  }
  if (typeof input !== 'object' || input === null) invalid('Input must be a string or an object.')

  if (!('parts' in input)) {
    const { text, files } = input as { text?: unknown; files?: unknown }
    const parts: Array<TextUIPart | FileUIPart> = []
    if (text !== undefined) {
      if (typeof text !== 'string') invalid('Input `text` must be a string.')
      if (text.length > 0) parts.push({ type: 'text', text })
    }
    if (files !== undefined) {
      if (!Array.isArray(files)) invalid('Input `files` must be an array.')
      for (const file of files) parts.push(normalizeFile(file, 'Input files'))
    }
    if (parts.length === 0) invalid('Input is empty.')
    return { parts }
  }

  const message = input as Partial<HarnessUIMessage>
  if (message.role !== 'user') {
    invalid(`Input message must have role 'user' (got '${String(message.role)}').`, {
      role: message.role,
    })
  }
  if (!Array.isArray(message.parts)) invalid('Input message has no parts array.')
  const parts: Array<TextUIPart | FileUIPart> = []
  for (const part of message.parts as unknown[]) {
    const type = (part as { type?: unknown } | null)?.type
    if (type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text !== 'string') invalid('A text part needs a string `text`.')
      parts.push({ type: 'text', text })
    } else if (type === 'file') {
      parts.push(normalizeFile(part, 'Input message'))
    } else {
      invalid(
        `Input message contains a part of type '${String(type)}'; only 'text' and 'file' parts are accepted.`,
        { partType: type },
      )
    }
  }
  if (parts.length === 0) invalid('Input message has no text or file parts.')

  const out: NormalizedInput = { parts }
  if (typeof message.id === 'string' && message.id.length > 0) out.clientId = message.id
  if (options.acceptClientMetadata === true && typeof message.metadata === 'object') {
    const appMetadata: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(message.metadata ?? {})) {
      if (key !== 'eharness') appMetadata[key] = value
    }
    if (Object.keys(appMetadata).length > 0) out.appMetadata = structuredClone(appMetadata)
  }
  return out
}

/** Build the stored user message from normalized input (ids and metadata are server-owned). */
export function buildUserMessage(
  input: NormalizedInput,
  meta: {
    id: string
    turnId: string
    createdAt: number
    parentId?: string | null
    augmented?: number
  },
): HarnessUIMessage {
  const eharness: NonNullable<NonNullable<HarnessUIMessage['metadata']>['eharness']> = {
    v: 1,
    createdAt: meta.createdAt,
    turnId: meta.turnId,
  }
  if (input.clientId !== undefined) eharness.clientId = input.clientId
  if (meta.parentId !== undefined) eharness.parentId = meta.parentId
  if (meta.augmented !== undefined && meta.augmented > 0) eharness.augmented = meta.augmented
  return {
    id: meta.id,
    role: 'user',
    metadata: { ...(input.appMetadata ?? {}), eharness },
    parts: structuredClone(input.parts),
  }
}
