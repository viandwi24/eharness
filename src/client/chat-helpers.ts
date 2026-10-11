/**
 * Pure helpers of the chat session: error wording, message paging, interrupted turns.
 *
 * @see docs/specs/27-client.md#5-chat-session
 */
import type { UIMessage } from 'ai'
import { isHarnessHttpError } from './http-client.ts'

/** How a chat failure reaches the person. */
export interface ChatProblem {
  message: string
  /** What Retry does; `null` = nothing to retry (answer the waiting item, or dismiss). */
  retry: 'follow' | null
}

const MAX = 220
const clip = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text)

/**
 * The problem to show for `error`, or `null` when it is not worth showing (an answer to an item
 * that is not waiting any more). `serverTurn`: the failed request followed a turn the server
 * started (Retry re-attaches).
 */
export function describeChatError(error: unknown, serverTurn: boolean): ChatProblem | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = isHarnessHttpError(error) ? error.code : (error as { code?: unknown } | null)?.code
  if (code === 'EH_HTTP_ALREADY_ANSWERED' || code === 'EH_HTTP_DUPLICATE_REQUEST') return null
  if (
    code === 'EH_PENDING_RESPONSE' ||
    /still unanswered|waiting for (an|your) answer|are waiting/i.test(text)
  ) {
    return {
      message:
        'A question or approval in this chat is waiting for your answer. Answer it first, then continue.',
      retry: null,
    }
  }
  if (code === 'EH_SESSION_CLOSED') return { message: 'This chat is closed.', retry: null }
  if (
    code === 'EH_SESSION_BUSY' ||
    /busy with a turn|locked by another instance|already running/i.test(text)
  ) {
    return {
      message: 'The agent is busy with another turn. It will show here when it finishes.',
      retry: serverTurn ? 'follow' : null,
    }
  }
  if (code === 'EH_HTTP_UNAUTHORIZED' || code === 'EH_HTTP_FORBIDDEN') {
    return { message: 'You are not allowed to use this chat. Sign in again.', retry: null }
  }
  if (
    !isHarnessHttpError(error) &&
    (error instanceof TypeError || /failed to fetch|network|load failed|cannot reach/i.test(text))
  ) {
    return {
      message: 'Cannot reach the server. Check your connection.',
      retry: serverTurn ? 'follow' : null,
    }
  }
  const message = text.trim()
    ? clip(text.trim())
    : 'Something went wrong while following the agent.'
  return { message, retry: serverTurn ? 'follow' : null }
}

/** Prepend an older page, dropping ids already present (pages may overlap with live messages). */
export function mergeOlder<UI extends UIMessage>(current: UI[], older: UI[]): UI[] {
  const have = new Set(current.map((m) => m.id))
  return [...older.filter((m) => !have.has(m.id)), ...current]
}

/** Replace the newest part of `current` with a freshly fetched tail page; older loaded pages stay. */
export function replaceTail<UI extends UIMessage>(current: UI[], tail: UI[]): UI[] {
  const first = tail[0]
  if (first === undefined) return current
  // ids sort by creation time (UUIDv7): everything older than the page's first id is kept as is
  return [...current.filter((m) => m.id < first.id), ...tail]
}

type Meta = { eharness?: { stop?: string; kind?: string } } | undefined

/**
 * The interrupted assistant message (stop `interrupted`, spec 05 §9) when it is the end of the
 * conversation (kind messages such as the recovery notice do not count), else `undefined`.
 */
export function interruptedTurn<UI extends UIMessage>(messages: readonly UI[]): UI | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as UI
    const eh = (m.metadata as Meta)?.eharness
    if (eh?.kind !== undefined) continue
    return m.role === 'assistant' && eh?.stop === 'interrupted' ? m : undefined
  }
  return undefined
}

/** What Continue sends. */
export const CONTINUE_TEXT = 'Continue where you left off.'
