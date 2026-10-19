/**
 * Payload types of the core message kinds.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type {
  CompactionPayload,
  EventPayload,
  FlushPayload,
  NoticePayload,
  RewindPayload,
} from '../../messages/types.ts'

/**
 * Payload types of the core message kinds.
 *
 * @see docs/specs/03-messages.md#53-core-kinds
 */
export type HarnessKindTypes = {
  'eh.compaction': CompactionPayload
  'eh.notice': NoticePayload
  'eh.event': EventPayload
  'eh.rewind': RewindPayload
  'eh.flush': FlushPayload
}

/** Kind names of a kind payload map (e.g. `AgentKindTypes<C>`). */
export type KindName<Kinds> = keyof Kinds & string

/** Payload type of kind `K` in a kind payload map. */
export type KindData<Kinds, K extends keyof Kinds> = Kinds[K]
