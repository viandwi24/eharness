/**
 * `eharness/activity`: the session activity feed (`activity()` plugin, `ActivityStore` port, SSE
 * helpers) and the attention queue (`listAttention`, `answerAttention`).
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
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
  type InMemoryActivityStoreOptions,
  inMemoryActivityStore,
} from './memory.ts'
export { type ActivityPluginOptions, activity } from './plugin.ts'
export {
  type ActivityPage,
  type ActivityStreamHandlerOptions,
  type ActivityStreamOptions,
  activityCursor,
  activityStream,
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
