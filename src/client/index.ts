/**
 * `eharness/client`: the browser counterpart of `eharness/http`. A typed fetch client, the AI SDK
 * chat transport, a framework-neutral chat session, the activity feed (SSE with reconnect and
 * restart detection), the attention inbox, and `Store<T>` (Svelte store contract, also accepted
 * by `useSyncExternalStore`).
 *
 * Runtime imports: only `ai`. Everything from `eharness/http` / `eharness/activity` is a type
 * (guarded by `check:imports` and `scripts/check-client-bundle.ts`, ADR-0059).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/27-client.md
 */

export type { ActivityPage, ActivityRecord, AttentionItem } from '../activity/index.ts'
export type {
  AnswerRequest,
  AnswerResponse,
  AttentionAnswerWire,
  AttentionItemWire,
  AttentionListResponse,
  ChatQueued,
  ClippedValue,
  HealthResponse,
  HttpErrorBody,
  HttpErrorCode,
  InterruptResult,
  MessagesPage,
  PendingSnapshot,
  SessionListResponse,
  SessionSnapshot,
  SessionSummary,
} from '../http/index.ts'
export {
  type ActivityFeed,
  type ActivityFeedOptions,
  type ActivityFeedState,
  createActivityFeed,
  type FeedStatus,
  type ResyncReason,
} from './activity-feed.ts'
export {
  ATTENTION_EVENTS,
  type AttentionKey,
  type AttentionList,
  type AttentionListOptions,
  type AttentionState,
  createAttentionList,
} from './attention.ts'
export {
  type ChatProblem,
  CONTINUE_TEXT,
  describeChatError,
  interruptedTurn,
  isClippedPart,
} from './chat-helpers.ts'
export {
  type ChatActivity,
  type ChatBridge,
  type ChatInit,
  type ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  createChatSession,
} from './chat-session.ts'
export type { Clock } from './clock.ts'
export {
  type FollowOptions,
  type FollowResult,
  followSessionStream,
} from './follow.ts'
export {
  type AttentionApi,
  type CallOptions,
  type ChatSendOptions,
  createHarnessClient,
  type HarnessClient,
  type HarnessClientOptions,
  HarnessHttpError,
  isHarnessHttpError,
  isNetworkError,
  type Resolvable,
  type SendResult,
  type SessionsApi,
} from './http-client.ts'
export type { Store, StoreLifecycle, StoreTimers, WritableStore } from './store.ts'
export { createHarnessTransport, type HarnessTransportOptions } from './transport.ts'
