/**
 * Inbox dedupe (internal): which inbox items a session already applied. An item is applied when
 * a stored user message carries its id (`metadata.eharness.inboxId` / `collected`), a stored
 * `data-eh.input` part carries it (a delivered steer), or it is listed in
 * `state.core.inboxDelivered` (the last 100 ids, written with the commit-point state write).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
import type { SessionStateSnapshot } from '../../agent/session-types.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'

/** Ids kept in `state.core.inboxDelivered`. */
export const INBOX_DELIVERED_MAX = 100

/** Inbox ids found in messages (user message metadata, `data-eh.input` parts). */
export function inboxIdsIn(messages: readonly HarnessUIMessage[]): Set<string> {
  const out = new Set<string>()
  for (const message of messages) {
    const eharness = message.metadata?.eharness
    if (typeof eharness?.inboxId === 'string') out.add(eharness.inboxId)
    for (const entry of eharness?.collected ?? []) {
      if (typeof entry?.inboxId === 'string') out.add(entry.inboxId)
    }
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type !== 'data-eh.input') continue
      const id = (part as { data?: { inboxId?: unknown } }).data?.inboxId
      if (typeof id === 'string') out.add(id)
    }
  }
  return out
}

/** Append ids to `core.inboxDelivered`, keeping the newest {@link INBOX_DELIVERED_MAX}. */
export function recordDelivered(core: SessionStateSnapshot['core'], ids: readonly string[]): void {
  if (ids.length === 0) return
  const kept = (core.inboxDelivered ?? []).filter((id) => !ids.includes(id))
  core.inboxDelivered = [...kept, ...ids].slice(-INBOX_DELIVERED_MAX)
}

/** Remove ids from `core.inboxDelivered` (their turn failed after the commit-point write). */
export function forgetDelivered(core: SessionStateSnapshot['core'], ids: readonly string[]): void {
  if (core.inboxDelivered === undefined) return
  const kept = core.inboxDelivered.filter((id) => !ids.includes(id))
  if (kept.length === 0) delete core.inboxDelivered
  else core.inboxDelivered = kept
}
