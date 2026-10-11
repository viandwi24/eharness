/**
 * Chat threads (docs/plans/P40-team-autonomous-operations.md, phase M). Pure.
 *
 * An agent has any number of chat threads and they are all equal: a thread is one eharness
 * session with a row that names it (title, source, archive flag). Session ids:
 *
 *   dm:<agentId>                 the thread that existed before threads did (migrated, see below)
 *   chat:<agentId>:<threadId>    every thread created since
 *   <chat session>:agent:<call>  a child session: work the lead handed to a role agent from a thread
 *
 * The migration is a convention, not a data move: the first time an agent's threads are listed
 * and it has none, a row is created for its existing `dm:<agentId>` session, so its history stays
 * where it is and keeps working under the old id. Nothing about that thread is special after that.
 */

/** Where a conversation comes from. `channel` is reserved for messaging channels (a later feature). */
export const THREAD_SOURCES = ['web', 'channel'] as const
export type ThreadSource = (typeof THREAD_SOURCES)[number]

/** What a thread was opened to discuss (`Discuss in chat`); shown as a chip, kept as context. */
export interface ThreadSeed {
  kind: 'briefing' | 'alert' | 'run'
  /** Id of the briefing, notification or task it came from. */
  ref: string
  title: string
}

export interface Thread {
  id: string
  agentId: string
  sessionId: string
  /** A person's name for it; null until set or derived from the first message. */
  title: string | null
  source: ThreadSource
  /** Where it comes from, for display, for example the name of a group (`source: 'channel'`). */
  sourceLabel: string | null
  seed: ThreadSeed | null
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  preview: string | null
  archivedAt: number | null
}

export const MAX_THREAD_TITLE = 80
export const DEFAULT_THREAD_TITLE = 'New chat'
export const FIRST_THREAD_TITLE = 'Chat'

/** `dm:<agentId>` is the thread of before; its session id is the old one. */
export const legacyThreadSessionId = (agentId: string): string => `dm:${agentId}`
export const threadSessionId = (agentId: string, threadId: string): string =>
  `chat:${agentId}:${threadId}`

export interface ParsedChatSession {
  agentId: string
  /** null for the legacy `dm:<agentId>` session. */
  threadId: string | null
  /** The session id of the thread itself (a child session maps to its parent thread). */
  threadSession: string
  /** True for the session of work handed to another agent from this thread. */
  child: boolean
}

/** The agent and thread of a chat or chat-child session id; undefined for any other session. */
export function parseChatSession(sessionId: string): ParsedChatSession | undefined {
  let m = /^dm:([^:]+)(:.*)?$/.exec(sessionId)
  if (m !== null) {
    const agentId = m[1] as string
    return { agentId, threadId: null, threadSession: `dm:${agentId}`, child: m[2] !== undefined }
  }
  m = /^chat:([^:]+):([^:]+)(:.*)?$/.exec(sessionId)
  if (m !== null) {
    const agentId = m[1] as string
    const threadId = m[2] as string
    return {
      agentId,
      threadId,
      threadSession: `chat:${agentId}:${threadId}`,
      child: m[3] !== undefined,
    }
  }
  return undefined
}

/** A thread's own session (not a child of it). */
export const isThreadSession = (sessionId: string): boolean => {
  // a channel conversation (`channel:<connection>:<conversation>`, `infra/channels`) is a thread too
  if (sessionId.startsWith('channel:')) return !/:agent:[^:]+$/.test(sessionId)
  const p = parseChatSession(sessionId)
  return p !== undefined && !p.child
}

export const cleanThreadTitle = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TITLE)

/** A title from the first words of a message. */
export function titleFromMessage(text: string): string | null {
  const clean = cleanThreadTitle(text.replace(/<[^>]*>/g, ' '))
  if (clean === '') return null
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean
}

/** Newest activity first; archived last (the order of the thread list). */
export function sortThreads(threads: readonly Thread[]): Thread[] {
  const at = (t: Thread): number => t.lastMessageAt ?? t.updatedAt
  return [...threads].sort(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      at(b) - at(a) ||
      (a.id < b.id ? 1 : -1),
  )
}

/** The text a "Discuss in chat" thread opens with: context only, written for the model and the reader. */
export function seedText(seed: ThreadSeed, body: string): string {
  const what = { briefing: 'a briefing item', alert: 'an alert', run: 'a run' }[seed.kind]
  return `The client opened this chat to talk about ${what}: ${seed.title}\n\n${body.trim()}`
}
