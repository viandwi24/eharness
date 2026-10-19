/** Reading a turn's messages back: trigger ids, final text, delegation (pure). */

export const EVENT_PREFIX = 'ev:'
/**
 * The id of the one wake that hands a job over to the background worker after a chat turn ended
 * `max-steps` (`<prefix><trigger message id>`). It answers the same message as the turn it follows.
 */
export const HANDOVER_PREFIX = 'handover:'
/** The chat message an inbox key answers (a message event or its hand-over), or undefined. */
export const triggerOfKey = (key: string | undefined): string | undefined =>
  key === undefined
    ? undefined
    : key.startsWith(EVENT_PREFIX)
      ? key.slice(EVENT_PREFIX.length)
      : key.startsWith(HANDOVER_PREFIX)
        ? key.slice(HANDOVER_PREFIX.length)
        : undefined
/** The idempotency prefix of the reply to the wake turn a finished background delegation starts. */
export const REPORT_PREFIX = 'wake:'
export const MAX_ATTACHMENTS = 4
export const TYPING_EVERY_MS = 4000
export const REPLY_EXCERPT = 200

/** A bare mention looks back this far, and at most this many messages, for the request before it. */
export const CALL_ONLY_WINDOW_MS = 10 * 60_000
export const CALL_ONLY_MESSAGES = 5

/** A "ya" / "tidak" reply answers only requests announced this recently (older ones: the web app). */
export const TEXT_ANSWER_MAX_AGE_MS = 10 * 60_000

import type { NodeRow } from '../model.ts'
import type { ConversationKind } from './types.ts'

export const kindOfNode = (node: NodeRow): ConversationKind =>
  node.kind === 'direct' ? 'dm' : node.traits.broadcast ? 'channel' : 'group'

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function delegatedIn(messages: ReadonlyArray<{ role: string; parts?: unknown }>): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.parts) &&
      (m.parts as Array<{ type?: string }>).some((p) => p.type === 'tool-agent'),
  )
}

export function finalAssistantText(
  messages: ReadonlyArray<{ role: string; parts?: unknown }>,
): string {
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const parts = Array.isArray(assistant?.parts)
    ? (assistant.parts as Array<{ type?: string; text?: string }>)
    : []
  let from = 0
  parts.forEach((p, i) => {
    const t = p.type ?? ''
    if (t.startsWith('tool-') || t === 'dynamic-tool') from = i + 1
  })
  return parts
    .slice(from)
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim()
}

/** Message ids (ours) of the channel events a turn's user messages carry. */
export function triggerIds(
  messages: ReadonlyArray<{ role: string; metadata?: unknown }>,
): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    const meta = (
      m.metadata as
        | { eharness?: { inboxKey?: string; collected?: Array<{ inboxKey?: string }> } }
        | undefined
    )?.eharness
    const keys = [
      ...(meta?.collected?.map((c) => c.inboxKey) ?? []),
      ...(meta?.collected === undefined ? [meta?.inboxKey] : []),
    ]
    for (const key of keys) {
      const id = triggerOfKey(key)
      if (id !== undefined) out.push(id)
    }
  }
  return out
}
