/**
 * `eharness/client`: the browser counterpart of `eharness/http`. A typed fetch client, the AI SDK
 * chat transport, a framework-neutral chat session, the activity feed (SSE with reconnect and
 * restart detection), the attention inbox, and `Store<T>` (Svelte store contract, also accepted
 * by `useSyncExternalStore`).
 *
 * Runtime imports: only `ai`. Everything from `eharness/http` / `eharness/activity` is a type
 * (guarded by `check:imports` and `scripts/check-client-bundle.ts`, ADR-0059).
 *
 * @see docs/specs/27-client.md
 */

export type { ActivityPage, ActivityRecord, AttentionItem } from '../activity/index.ts'
export type {
  AnswerRequest,
  AnswerResponse,
  AttentionAnswerWire,
  AttentionListResponse,
  ChatQueued,
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
  parseActivityEvent,
  type ResyncReason,
} from './activity-feed.ts'
export {
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
  mergeOlder,
  replaceTail,
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
export { type Clock, systemClock } from './clock.ts'
export {
  type AttentionApi,
  type CallOptions,
  createHarnessClient,
  type HarnessClient,
  type HarnessClientOptions,
  HarnessHttpError,
  isHarnessHttpError,
  isNetworkError,
  type Resolvable,
  readHttpError,
  type SendOptions,
  type SendResult,
  type SessionsApi,
} from './http-client.ts'
export {
  type BootCheck,
  backoffDelay,
  createLiveness,
  type Health,
  type Liveness,
  type LivenessOptions,
} from './liveness.ts'
export { createSseParser, type SseMessage, type SseParser } from './sse.ts'
export {
  createStore,
  type Store,
  type StoreLifecycle,
  type StoreTimers,
  type WritableStore,
} from './store.ts'
export {
  createHarnessTransport,
  emptyStreamResponse,
  type HarnessTransportOptions,
} from './transport.ts'
