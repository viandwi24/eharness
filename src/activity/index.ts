/**
 * `eharness/activity`: the session activity feed (`activity()` plugin, `ActivityStore` port, SSE
 * helpers) and the attention queue (`listAttention`, `answerAttention`).
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/specs/25-activity.md
 */

export {
  type AnswerAttentionOptions,
  type AnswerAttentionResult,
  type AttentionAnswer,
  type AttentionItem,
  type AttentionKind,
  type AttentionPeekFn,
  type AttentionSession,
  answerAttention,
  type ListAttentionOptions,
  listAttention,
} from './attention.ts'
export {
  type MemoryActivityStoreOptions,
  memoryActivityStore,
  pruneBoundary,
} from './memory.ts'
export { type ActivityPluginOptions, activity, pendingRefs } from './plugin.ts'
export {
  type ActivityPage,
  type ActivityStreamHandlerOptions,
  type ActivityStreamOptions,
  activityCursor,
  activityStream,
  encodeActivityEvent,
  handleActivityStream,
  readActivityPage,
} from './sse.ts'
export {
  type ActivityInput,
  type ActivityPruneOptions,
  type ActivityReadQuery,
  type ActivityRecord,
  type ActivityStore,
  type PendingRef,
  SESSION_ACTIVITY_TYPES,
  type SessionActivityPayloads,
  type SessionActivityType,
  type TurnSourceKind,
} from './types.ts'
