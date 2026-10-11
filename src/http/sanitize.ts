/**
 * The chat request body whitelist (spec 26 §5.2): everything the server reads of a `useChat`
 * request, and nothing else. Errors are values.
 *
 * @see docs/specs/26-http.md#52-body-whitelist
 */
import type { UIMessage } from 'ai'
import type { ChatRequestBody } from '../index.ts'

/** Limits and switches of {@link sanitizeChatBody}. */
export interface SanitizeCaps {
  /** The session id of the path: the body `id` must equal it. Not checked when omitted. */
  sessionId?: string
  /** Parts of the last message. Default 32. */
  maxParts?: number
  /** UTF-8 bytes of one text part. Default 64 KiB. */
  maxTextBytes?: number
  /** Read `clientTools` from the body. Default `false`. */
  clientTools?: boolean
  /** Read `pageContext` from the body. Default `false`. */
  pageContext?: boolean
}

/** Why a body was refused. */
export interface SanitizeProblem {
  code: 'EH_INVALID_INPUT' | 'EH_HTTP_INVALID_BODY'
  message: string
  details?: Record<string, unknown>
}

/** The outcome of {@link sanitizeChatBody}. */
export type SanitizeResult =
  | {
      ok: true
      /** The body `handleChatRequest` gets: at most one message, whitelisted fields only. */
      body: ChatRequestBody
      /** The client id of the last message (its `id`), when it had one. */
      clientId?: string
    }
  | ({ ok: false } & SanitizeProblem)

/** The operation a sanitized body will run. */
export type ChatKind = 'send' | 'respond' | 'regenerate' | 'edit'

const DEFAULT_MAX_PARTS = 32
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024
const encoder = new TextEncoder()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const bad = (message: string, details?: Record<string, unknown>): SanitizeResult => ({
  ok: false,
  code: 'EH_HTTP_INVALID_BODY',
  message,
  ...(details === undefined ? {} : { details }),
})
const invalid = (message: string, details: Record<string, unknown>): SanitizeResult => ({
  ok: false,
  code: 'EH_INVALID_INPUT',
  message,
  details,
})

function isToolType(type: string): boolean {
  return type.startsWith('tool-') || type === 'dynamic-tool'
}

/** Decision-only copy of a tool part of a client's assistant message, or `undefined`. */
function decisionPart(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !isToolType(raw.type)) return undefined
  const base = {
    type: raw.type,
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
  }
  if (raw.state === 'approval-responded') {
    const approval = raw.approval
    if (!isRecord(approval) || typeof approval.id !== 'string') return undefined
    if (typeof approval.approved !== 'boolean') return undefined
    return {
      ...base,
      state: 'approval-responded',
      ...(typeof raw.toolCallId === 'string' ? { toolCallId: raw.toolCallId } : {}),
      approval: {
        id: approval.id,
        approved: approval.approved,
        ...(typeof approval.reason === 'string' ? { reason: approval.reason } : {}),
      },
    }
  }
  if (typeof raw.toolCallId !== 'string') return undefined
  if (raw.state === 'output-available' && raw.preliminary !== true) {
    return { ...base, state: 'output-available', toolCallId: raw.toolCallId, output: raw.output }
  }
  if (raw.state === 'output-error' && typeof raw.errorText === 'string') {
    return { ...base, state: 'output-error', toolCallId: raw.toolCallId, errorText: raw.errorText }
  }
  return undefined
}

/**
 * Validate and reduce a parsed `useChat` request body (spec 26 §5.2).
 *
 * - Only the last message is kept. A user message keeps `{ id, role, parts }` with `text` and
 *   `file` parts only (any other part type is `EH_INVALID_INPUT`); its metadata is dropped. An
 *   assistant message (a `respond`) keeps only the tool parts that carry a decision.
 * - `trigger` must be `submit-message` or `regenerate-message`; `messageId` a non-empty string.
 * - `clientTools` / `pageContext` are read only when the caps enable them.
 * - `actor`, `runtime`, `toolsContext`, `ifBusy`, `maxSteps`, `model`, `settings`, `output` and
 *   `endTurn` are never read: the server decides them.
 */
export function sanitizeChatBody(raw: unknown, caps: SanitizeCaps = {}): SanitizeResult {
  if (!isRecord(raw)) return bad('The body must be a JSON object.')
  if (caps.sessionId !== undefined && raw.id !== caps.sessionId) {
    return bad('The body id must equal the session id of the path.', { reason: 'id-mismatch' })
  }
  const trigger = raw.trigger
  if (trigger !== undefined && trigger !== 'submit-message' && trigger !== 'regenerate-message') {
    return bad('Unknown trigger.', { reason: 'trigger' })
  }
  const messageId = raw.messageId
  if (messageId !== undefined && (typeof messageId !== 'string' || messageId === '')) {
    return bad('messageId must be a non-empty string.', { reason: 'message-id' })
  }
  if (!Array.isArray(raw.messages)) return bad('messages must be an array.', { reason: 'messages' })

  const extra: Partial<ChatRequestBody> = {}
  if (caps.clientTools === true && raw.clientTools != null) {
    if (!Array.isArray(raw.clientTools)) return bad('clientTools must be an array.')
    extra.clientTools = raw.clientTools as ChatRequestBody['clientTools'] & unknown[]
  }
  if (caps.pageContext === true && raw.pageContext != null) {
    if (!Array.isArray(raw.pageContext)) return bad('pageContext must be an array.')
    extra.pageContext = raw.pageContext as ChatRequestBody['pageContext'] & unknown[]
  }
  const head: Pick<ChatRequestBody, 'trigger' | 'messageId'> = {
    ...(trigger === undefined ? {} : { trigger }),
    ...(messageId === undefined ? {} : { messageId }),
  }

  const last: unknown = raw.messages.at(-1)
  if (last === undefined) {
    if (trigger === 'regenerate-message')
      return { ok: true, body: { messages: [], ...head, ...extra } }
    return bad('messages must not be empty.', { reason: 'messages' })
  }
  if (!isRecord(last)) return bad('A message must be an object.', { reason: 'message' })
  const id = typeof last.id === 'string' && last.id !== '' ? last.id : undefined
  const parts: unknown[] = Array.isArray(last.parts) ? last.parts : []

  if (last.role === 'assistant') {
    const kept = parts
      .map(decisionPart)
      .filter((p): p is Record<string, unknown> => p !== undefined)
    const message = { ...(id === undefined ? {} : { id }), role: 'assistant', parts: kept }
    return {
      ok: true,
      body: { messages: [message as unknown as UIMessage], ...head, ...extra },
      ...(id === undefined ? {} : { clientId: id }),
    }
  }
  if (last.role !== 'user')
    return bad('The last message role must be user or assistant.', { reason: 'role' })

  const maxParts = caps.maxParts ?? DEFAULT_MAX_PARTS
  if (parts.length > maxParts) {
    return invalid('Too many parts in the message.', { reason: 'too-many-parts', max: maxParts })
  }
  const maxText = caps.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
  const out: Array<Record<string, unknown>> = []
  for (const part of parts) {
    if (!isRecord(part)) return invalid('A part must be an object.', { reason: 'part' })
    if (part.type === 'text') {
      if (typeof part.text !== 'string')
        return invalid('A text part needs text.', { reason: 'part' })
      if (encoder.encode(part.text).byteLength > maxText) {
        return invalid('A text part is too large.', { reason: 'text-too-large', maxBytes: maxText })
      }
      out.push({ type: 'text', text: part.text })
    } else if (part.type === 'file') {
      if (typeof part.url !== 'string' || typeof part.mediaType !== 'string') {
        return invalid('A file part needs url and mediaType.', { reason: 'part' })
      }
      out.push({
        type: 'file',
        url: part.url,
        mediaType: part.mediaType,
        ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
      })
    } else {
      return invalid('This part type is not accepted from clients.', {
        reason: 'unsupported-part',
        type: typeof part.type === 'string' ? part.type : null,
      })
    }
  }
  const message = { ...(id === undefined ? {} : { id }), role: 'user', parts: out }
  return {
    ok: true,
    body: { messages: [message as unknown as UIMessage], ...head, ...extra },
    ...(id === undefined ? {} : { clientId: id }),
  }
}

/** The operation `handleChatRequest` will run for a body (the same dispatch it uses). */
export function classifyChatBody(body: ChatRequestBody): ChatKind {
  if (body.trigger === 'regenerate-message') return 'regenerate'
  const last = body.messages.at(-1)
  if (last?.role === 'assistant') return 'respond'
  if (body.messageId !== undefined && last?.role === 'user') return 'edit'
  return 'send'
}
