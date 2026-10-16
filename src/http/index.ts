/**
 * `eharness/http`: a `fetch`-style HTTP module for an agent: a `useChat` endpoint with resume,
 * steering and interrupt, session reads, the attention queue and the activity feed, behind one
 * `authorize` hook. Web APIs only (`Request` / `Response`).
 *
 * Imports core only through `src/index.ts` and `eharness/activity` (ADR-0008, ADR-0059).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/26-http.md
 */

export {
  type Authorize,
  type AuthorizeCall,
  type HttpDeny,
  openAccess,
} from './authorize.ts'
export type { ClippedValue } from './clip.ts'
export { createHarnessHttp } from './router.ts'
export type {
  AttentionTarget,
  HarnessHttp,
  HarnessHttpOptions,
  HttpActivityOptions,
  HttpAttentionOptions,
  HttpChatOptions,
  HttpMatch,
  HttpRoute,
  HttpSessionsOptions,
  SessionCtx,
} from './types.ts'
export type {
  AnswerRequest,
  AnswerResponse,
  AttentionAnswerWire,
  AttentionItemWire,
  AttentionListResponse,
  ChatQueued,
  HealthResponse,
  HttpAction,
  HttpErrorBody,
  HttpErrorCode,
  HttpLayerErrorCode,
  InterruptRequest,
  InterruptResult,
  MessagesPage,
  PendingSnapshot,
  SessionListResponse,
  SessionSnapshot,
  SessionSummary,
} from './wire.ts'
