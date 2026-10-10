/** Chat use cases: validate the request, resolve attachments, hand over to the chat port. */
import {
  dmSessionId,
  isAllowedMediaType,
  libraryUrl,
  MAX_UPLOAD_BYTES,
  uploadPath,
  uploadPathOfUrl,
} from '../domain/chat.ts'
import { conflict, invalid } from '../domain/errors.ts'
import { getAgent } from './agents.ts'
import type {
  Actor,
  ChatInput,
  ChatMessage,
  ChatOutcome,
  ChatStats,
  Deps,
  StoredUpload,
} from './ports.ts'

/** The single user of v1 (plan §6.7). */
export const OWNER: Actor = { id: 'owner' }

export { dmSessionId }

function liveAgent(deps: Deps, idOrSlug: string) {
  const agent = getAgent(deps, idOrSlug)
  if (agent.archivedAt !== null) {
    throw conflict(`agent is archived: ${agent.slug}`, 'AGENT_ARCHIVED')
  }
  return agent
}

/** Reading history of an archived agent stays possible (plan §5.1: delete = archive). */
const anyAgent = getAgent

/**
 * Check the file parts of the message the client sent. `library:` references name an uploaded
 * file and **stay references** in the stored message: the agent resolves them to bytes only when
 * it builds the model request (`inputFiles.resolve`, `infra/eh/agent-factory.ts`). The client
 * never names a path outside `/uploads`, and a media type outside the allowlist is rejected
 * whatever the URL scheme.
 */
async function checkFiles(deps: Deps, message: ChatMessage): Promise<ChatMessage> {
  const parts: ChatMessage['parts'] = []
  for (const part of message.parts) {
    if (part.type !== 'file') {
      parts.push(part)
      continue
    }
    const url = part.url
    const mediaType = part.mediaType
    if (typeof url !== 'string' || typeof mediaType !== 'string') {
      throw invalid('a file part needs a string url and mediaType', 'INVALID_FILE')
    }
    if (!isAllowedMediaType(mediaType)) {
      throw invalid(`attachments of type ${mediaType} are not accepted`, 'UNSUPPORTED_MEDIA_TYPE')
    }
    const path = uploadPathOfUrl(url)
    if (path === undefined) {
      parts.push(part)
      continue
    }
    const file = await deps.uploads.stat(path)
    if (file === undefined) throw invalid(`no such upload: ${path}`, 'INVALID_FILE_REF')
    const name = typeof part.filename === 'string' ? part.filename : path.split('/').pop()
    parts.push({
      type: 'file',
      mediaType: file.mediaType,
      url: libraryUrl(path),
      ...(name === undefined ? {} : { filename: name }),
    })
  }
  return { ...message, parts }
}

export interface ChatRequest {
  messages: ChatMessage[]
  trigger?: 'submit-message' | 'regenerate-message'
  messageId?: string
}

export async function chat(
  deps: Deps,
  agentId: string,
  body: ChatRequest,
  options: { ifBusy?: 'steer' | 'reject' } = {},
): Promise<ChatOutcome> {
  const agent = liveAgent(deps, agentId)
  const last = body.messages.at(-1)
  if (body.trigger !== 'regenerate-message' && last === undefined) {
    throw invalid('messages must contain at least one message', 'INVALID_MESSAGES')
  }
  // only the last message is read (spec 11 §7); history, ids and metadata of the client are not
  const input: ChatInput = {
    messages:
      last === undefined ? [] : [last.role === 'user' ? await checkFiles(deps, last) : last],
    ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
    ...(body.messageId === undefined ? {} : { messageId: body.messageId }),
  }
  return deps.chat.chat(agent, input, { actor: OWNER, ifBusy: options.ifBusy ?? 'steer' })
}

export function resumeChat(deps: Deps, agentId: string, request: Request): Promise<Response> {
  return deps.chat.resume(anyAgent(deps, agentId), request)
}

export function abortChat(deps: Deps, agentId: string, reason?: string) {
  return deps.chat.abort(anyAgent(deps, agentId), reason)
}

export function chatMessages(
  deps: Deps,
  agentId: string,
  query: { before?: string; limit: number },
) {
  return deps.chat.messages(anyAgent(deps, agentId), query)
}

export function compactChat(deps: Deps, agentId: string) {
  return deps.chat.compact(liveAgent(deps, agentId))
}

export function chatStats(deps: Deps, agentId: string): Promise<ChatStats> {
  return deps.chat.stats(anyAgent(deps, agentId))
}

/** Store an uploaded file in the library's uploads folder. */
export async function uploadFile(
  deps: Deps,
  file: { name: string; mediaType: string; bytes: Uint8Array },
): Promise<StoredUpload & { name: string; url: string }> {
  if (file.bytes.byteLength === 0) throw invalid('the file is empty', 'EMPTY_FILE')
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw invalid(`the file is larger than ${MAX_UPLOAD_BYTES} bytes`, 'FILE_TOO_LARGE')
  }
  if (!isAllowedMediaType(file.mediaType)) {
    throw invalid(
      `files of type ${file.mediaType || '(unknown)'} are not accepted`,
      'UNSUPPORTED_MEDIA_TYPE',
    )
  }
  const path = uploadPath(deps.clock.now(), deps.ids.next(), file.name)
  const stored = await deps.uploads.put(path, file.bytes, file.mediaType)
  return { ...stored, name: path.split('/').pop() as string, url: libraryUrl(stored.path) }
}
