/**
 * Loading the model context (cold load): the one-query compaction pointer path, the paging
 * fallback, validation, boundary ordering, rewind view rule and state healing (internal).
 *
 * @see docs/specs/05-session-and-storage.md#5-loading-the-model-context-fixed-algorithm
 */
import type { MessageAdapter, SessionStateSnapshot } from '../agent/session-types.ts'
import { HarnessError, type HarnessWarning, isHarnessError } from '../errors.ts'
import { isKindMessage, kindOf } from '../messages/kinds.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { CompactionPayload, HarnessUIMessage, RewindPayload } from '../messages/types.ts'
import { type InvalidMessagePolicy, validateStoredMessages } from '../messages/validate.ts'

/** Page size of the paging fallback. */
export const PAGE_SIZE = 100

/** Result of {@link loadContext}. */
export interface LoadedContext {
  /** `[boundary?] + visible messages`, id order. */
  view: HarnessUIMessage[]
  /** Newest stored id (before validation), `undefined` for an empty session. */
  newestId: string | undefined
  warnings: HarnessWarning[]
}

export type Loose = { id?: unknown; metadata?: unknown; parts?: unknown }

export function isBoundary(message: Loose, registry: MessageRegistry): boolean {
  const kind = kindOf(message)
  return kind !== undefined && registry.kind(kind)?.def.boundary === true
}

function payloadOf<T>(message: HarnessUIMessage): T | undefined {
  return (message.parts[0] as { data?: T } | undefined)?.data
}

/** True when a message is hidden by one of `rewinds` (spec 11 §5 view rule). */
export function hiddenByRewind(
  message: HarnessUIMessage,
  rewinds: ReadonlyArray<{ afterId: string | null; rewindId: string }>,
  registry: MessageRegistry,
): boolean {
  if (isBoundary(message, registry) || isKindMessage(message, 'eh.rewind')) return false
  return rewinds.some(
    (r) => (r.afterId === null || r.afterId < message.id) && message.id < r.rewindId,
  )
}

/** Rewinds (as `{ afterId, rewindId }`) among `messages`. */
export function rewindsIn(
  messages: readonly HarnessUIMessage[],
): Array<{ afterId: string | null; rewindId: string }> {
  const out: Array<{ afterId: string | null; rewindId: string }> = []
  for (const message of messages) {
    if (!isKindMessage(message, 'eh.rewind')) continue
    const payload = payloadOf<RewindPayload>(message)
    if (payload === undefined) continue
    out.push({ afterId: payload.afterId ?? null, rewindId: message.id })
  }
  return out
}

/**
 * Load the context of a session (spec 05 §5): with a compaction pointer, one range query
 * `load({ fromId: resumeFromId ?? markerId })`; otherwise (or when that range holds no boundary)
 * page backwards 100 at a time until a boundary (and everything it keeps) is loaded or history is
 * exhausted. Then validate; assemble `[newest boundary] + messages from its resumeFromId`; apply
 * the rewind view rule; heal `state.core.compaction` / `state.core.activeTurn` (marking the state
 * dirty via `markDirty`).
 */
export async function loadContext(args: {
  adapter: MessageAdapter
  sessionId: string
  registry: MessageRegistry
  policy: InvalidMessagePolicy
  core: SessionStateSnapshot['core']
  markDirty: () => void
}): Promise<LoadedContext> {
  const { adapter, sessionId, registry } = args
  let raw: Loose[] = []
  let beforeId: string | undefined
  const pointer = args.core.compaction
  let paging = pointer === undefined
  try {
    if (pointer !== undefined) {
      raw = (await adapter.load({
        sessionId,
        fromId: pointer.resumeFromId ?? pointer.markerId,
      })) as Loose[]
      // the range starts at or before the marker, so it holds a boundary unless the stored
      // history changed behind our back: fall back to paging (and heal the pointer)
      if (!raw.some((m) => isBoundary(m, registry))) {
        raw = []
        paging = true
      }
    }
    while (paging) {
      const page = (await adapter.load(
        beforeId === undefined
          ? { sessionId, limit: PAGE_SIZE }
          : { sessionId, limit: PAGE_SIZE, beforeId },
      )) as Loose[]
      raw = [...page, ...raw]
      if (page.length < PAGE_SIZE || boundaryLoaded(raw, registry)) paging = false
      const oldest = page[0]?.id
      if (typeof oldest !== 'string') paging = false
      else beforeId = oldest
    }
  } catch (error) {
    if (isHarnessError(error)) throw error
    throw new HarnessError('EH_STORAGE', 'Message storage failed (load).', { cause: error })
  }
  const newestRaw = raw.at(-1)?.id
  const newestId = typeof newestRaw === 'string' ? newestRaw : undefined

  const { messages, warnings } = await validateStoredMessages(raw, registry, args.policy)
  messages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let boundary: HarnessUIMessage | undefined
  for (const message of messages) {
    if (isBoundary(message, registry) && (boundary === undefined || message.id > boundary.id)) {
      boundary = message
    }
  }
  let view: HarnessUIMessage[]
  if (boundary === undefined) {
    view = messages.filter((m) => !isBoundary(m, registry))
    if (args.core.compaction !== undefined) {
      delete args.core.compaction // points at a marker that no longer exists
      args.markDirty()
    }
  } else {
    const payload = payloadOf<CompactionPayload>(boundary)
    const resumeFromId = payload?.resumeFromId ?? null
    const start = resumeFromId ?? boundary.id
    view = [boundary, ...messages.filter((m) => !isBoundary(m, registry) && m.id >= start)]
    const pointer = args.core.compaction
    if (pointer === undefined || pointer.markerId !== boundary.id) {
      args.core.compaction = { markerId: boundary.id, resumeFromId }
      args.markDirty()
    }
  }

  const rewinds = rewindsIn(messages)
  if (rewinds.length > 0) view = view.filter((m) => !hiddenByRewind(m, rewinds, registry))

  // heal the rewind mirror (spec 11 §5): the markers in the loaded range are the source of truth;
  // mirror entries older than the loaded range (not visible here) are kept
  const oldestLoaded = typeof raw[0]?.id === 'string' ? (raw[0]?.id as string) : undefined
  const mirror = args.core.rewinds ?? []
  const healed = [
    ...mirror.filter((r) => oldestLoaded !== undefined && r.rewindId < oldestLoaded),
    ...rewinds,
  ]
  if (JSON.stringify(healed) !== JSON.stringify(mirror)) {
    if (healed.length === 0) delete args.core.rewinds
    else args.core.rewinds = healed
    args.markDirty()
  }

  // heal activeTurn: its assistant message was finalized (the end-of-turn state write was lost)
  const active = args.core.activeTurn
  if (active !== undefined) {
    const message = messages.find((m) => m.id === active.messageId)
    if (message?.metadata?.eharness?.stop !== undefined) {
      delete args.core.activeTurn
      args.markDirty()
    }
  }
  return { view, newestId, warnings }
}

function boundaryLoaded(raw: readonly Loose[], registry: MessageRegistry): boolean {
  for (let i = raw.length - 1; i >= 0; i--) {
    const message = raw[i] as Loose
    if (!isBoundary(message, registry)) continue
    const data = ((message.parts as unknown[] | undefined)?.[0] as { data?: unknown } | undefined)
      ?.data as Partial<CompactionPayload> | undefined
    const resumeFromId = data?.resumeFromId ?? null
    if (resumeFromId === null) return true
    return raw.some((m) => typeof m.id === 'string' && m.id <= resumeFromId)
  }
  return false
}
