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

const textOf = (m: UIMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

/**
 * Replace the newest part of `current` with a freshly fetched tail page; older loaded pages stay.
 *
 * - The optimistic user messages at the end of `current` (AI SDK made up their ids) that the
 *   server stored for real (the page holds a new user message with the same text) are dropped, so
 *   they never survive a refetch as duplicates.
 * - When the page starts after everything shown and older messages exist (`hasOlder`: the response
 *   had `nextBefore`), more than one page was stored meanwhile: keeping the old messages would leave
 *   a hole, so only the page is kept (`gap: true`) and paging restarts from it. Whether the page is
 *   adjacent needs the page before it: the first call answers `check: true`, the caller fetches
 *   `before` (the page older than the tail) and calls again.
 */
export function replaceTail<UI extends UIMessage>(
  current: UI[],
  tail: UI[],
  hasOlder = false,
  before?: UI[],
): { messages: UI[]; gap: boolean; check: boolean } {
  const first = tail[0]
  if (first === undefined) return { messages: current, gap: false, check: false }
  const inPage = new Set(tail.map((m) => m.id))
  const shown = new Set(current.map((m) => m.id))
  const storedTexts = tail
    .filter((m) => m.role === 'user' && !shown.has(m.id))
    .map((m) => textOf(m))
  // the trailing run of user messages the page does not hold: possibly client-only (optimistic)
  let start = current.length
  while (start > 0) {
    const m = current[start - 1] as UI
    if (m.role !== 'user' || inPage.has(m.id)) break
    start--
  }
  const optimistic = new Set<string>()
  for (const m of current.slice(start)) {
    const i = storedTexts.indexOf(textOf(m))
    if (i === -1) continue
    storedTexts.splice(i, 1)
    optimistic.add(m.id)
  }
  const kept = current.filter((m) => !inPage.has(m.id) && !optimistic.has(m.id))
  // client-only messages that remain have unrelated ids: they do not say what is newest
  const pending = new Set(current.slice(start).map((m) => m.id))
  let newest: string | undefined
  for (const m of kept)
    if (!pending.has(m.id) && (newest === undefined || m.id > newest)) newest = m.id
  if (hasOlder && newest !== undefined && first.id > newest) {
    // the page starts after everything shown: is it adjacent? `before` is the page right before it
    if (before === undefined) return { messages: current, gap: false, check: true }
    if (!before.some((m) => m.id === newest)) return { messages: tail, gap: true, check: false }
    const between = before.filter((m) => m.id > (newest as string) && !inPage.has(m.id))
    return { messages: [...kept, ...between, ...tail], gap: false, check: false }
  }
  // ids sort by creation time (UUIDv7): everything older than the page's first id is kept as is
  return { messages: [...kept.filter((m) => m.id < first.id), ...tail], gap: false, check: false }
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
