/** Chat use cases around `eharness/http`: attachment checks, compact, stats, tools menu, uploads. */
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
import type { Actor, ChatMessage, ChatStats, Deps, StoredUpload } from './ports.ts'
import { threadSessionOf } from './threads.ts'

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

/**
 * The body of `POST /sessions/{id}/chat` with its file parts checked (`checkFiles`), before the
 * library reads it. Anything that is not a user message with files passes unchanged: the library
 * whitelists and validates the rest. Throws `DomainError` for a bad attachment.
 */
export async function checkChatBody(deps: Deps, body: unknown): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return body
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return body
  const last = messages.at(-1) as ChatMessage | undefined
  if (last?.role !== 'user' || !Array.isArray(last.parts)) return body
  if (!last.parts.some((p) => p?.type === 'file')) return body
  return { ...body, messages: [...messages.slice(0, -1), await checkFiles(deps, last)] }
}

/** `threadId` names a chat thread of the agent; without it the thread with the newest activity. */
export function compactChat(deps: Deps, agentId: string, threadId?: string) {
  const agent = liveAgent(deps, agentId)
  return deps.chat.compact(agent, threadSessionOf(deps, agent, threadId))
}

export function getChatTools(deps: Deps, agentId: string, threadId?: string) {
  const agent = anyAgent(deps, agentId)
  return deps.chatTools.get(agent, threadSessionOf(deps, agent, threadId))
}

/** Switch connectors off (or back on) for this chat; the next model step sees the change. */
export function setChatTools(deps: Deps, agentId: string, off: string[], threadId?: string) {
  const agent = liveAgent(deps, agentId)
  return deps.chatTools.set(agent, threadSessionOf(deps, agent, threadId), off, deps.clock.now())
}

export function chatStats(deps: Deps, agentId: string, threadId?: string): Promise<ChatStats> {
  const agent = anyAgent(deps, agentId)
  return deps.chat.stats(agent, threadSessionOf(deps, agent, threadId))
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
