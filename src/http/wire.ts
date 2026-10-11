/**
 * Wire types of `eharness/http`: the JSON bodies of the routes (spec 26). Types only; the
 * `eharness/client` module imports them with `import type`, so nothing here may have a runtime
 * dependency.
 *
 * @see docs/specs/26-http.md
 */
import type { JSONValue, UIMessage } from 'ai'
import type { AttentionItem, AttentionKind } from '../activity/index.ts'
import type {
  ActiveTurn,
  HarnessErrorCode,
  HarnessNoticeCode,
  SessionBusy,
  SessionUsage,
} from '../index.ts'

/** Codes of the HTTP layer itself (spec 26 §3). */
export type HttpLayerErrorCode =
  | 'EH_HTTP_INVALID_JSON'
  | 'EH_HTTP_INVALID_BODY'
  | 'EH_HTTP_UNAUTHORIZED'
  | 'EH_HTTP_FORBIDDEN'
  | 'EH_HTTP_NOT_FOUND'
  | 'EH_HTTP_METHOD_NOT_ALLOWED'
  | 'EH_HTTP_ALREADY_ANSWERED'
  | 'EH_HTTP_DUPLICATE_REQUEST'
  | 'EH_HTTP_PAYLOAD_TOO_LARGE'
  | 'EH_HTTP_UNSUPPORTED_MEDIA_TYPE'

/**
 * Every code an error body of this module can carry: its own codes, core codes passed through,
 * `EH_INTERNAL`, and codes the app returns from `authorize` (`{ deny, code }`).
 */
export type HttpErrorCode =
  | HttpLayerErrorCode
  | HarnessErrorCode
  | HarnessNoticeCode
  | 'EH_INTERNAL'
  | (string & {})

/** The body of every non-2xx answer of the routes. */
export interface HttpErrorBody {
  error: { code: HttpErrorCode; message: string; details?: Record<string, unknown> }
}

/** `GET /health`. */
export interface HealthResponse {
  ok: true
  /** Id of this server process: a changed id tells a client the server restarted. */
  boot: string
}

/** One row of `GET /sessions` (the app decides the extra fields). */
export interface SessionSummary {
  id: string
  title?: string
  /** Epoch ms. */
  updatedAt?: number
  [key: string]: JSONValue | undefined
}

/** `GET /sessions` answer. */
export interface SessionListResponse {
  sessions: SessionSummary[]
  /** Pass as `cursor` to read the next page. */
  next?: string
}

/** The stored pending state of a session, without internals. */
export interface PendingSnapshot {
  /** The assistant message that waits. */
  messageId: string
  approvals: Array<{
    approvalId: string
    toolCallId: string
    toolName: string
    input?: unknown
    answered: boolean
  }>
  clientTools: Array<{
    toolCallId: string
    toolName: string
    input?: unknown
    timeoutAt?: number
    answered: boolean
  }>
  externals: Array<{
    waitId: string
    toolCallId: string
    toolName: string
    timeoutAt?: number
    resolved: boolean
  }>
}

/** `GET /sessions/:id`. A session that does not exist reads as an empty snapshot. */
export interface SessionSnapshot {
  id: string
  /** A turn runs somewhere (`busy !== null`). */
  running: boolean
  busy: SessionBusy | null
  activeTurn: ActiveTurn | null
  pending: PendingSnapshot | null
  usage: SessionUsage
  /** `sessions.describe(id)` of the app, when configured. */
  info?: Record<string, JSONValue>
}

/** `GET /sessions/:id/messages`. */
export interface MessagesPage {
  /** Oldest first. */
  messages: UIMessage[]
  /** Pass as `before` to read the older page; absent when the history starts here. */
  nextBefore?: string
}

/** `202` answer of `POST /sessions/:id/chat` when the input was handed to a running turn. */
export interface ChatQueued {
  inboxId: string
  delivered: 'steer'
  target: 'local' | 'remote'
  duplicate?: true
}

/** `POST /sessions/:id/interrupt` request body. */
export interface InterruptRequest {
  reason?: string
}

/** `POST /sessions/:id/interrupt` answer. */
export interface InterruptResult {
  target: 'local' | 'remote' | 'idle' | 'unsupported'
}

/** An attention item as sent: `extra` is what `attention.decorate` added (app-defined JSON). */
export type AttentionItemWire = AttentionItem & { extra?: Record<string, JSONValue> }

/** `GET /attention`. */
export interface AttentionListResponse {
  items: AttentionItemWire[]
}

/** The answers the wire accepts (`endTurn` is never read from the wire). */
export type AttentionAnswerWire =
  | {
      kind: 'approval'
      approved: boolean
      reason?: string
      note?: string
      remember?: 'once' | 'session'
    }
  | { kind: 'client-tool' | 'wait'; output: JSONValue }
  | { kind: 'client-tool' | 'wait'; errorText: string }

/** `POST /attention/:id/answer` request body. */
export interface AnswerRequest<Answer = AttentionAnswerWire> {
  /** The session that owns the item (`AttentionItem.sessionId`). */
  sessionId: string
  /** The wire answers, or the app-defined shapes its `parseAnswer` accepts. */
  answer: Answer
}

/** `POST /attention/:id/answer` answer (`not-found` is a 404 error body instead). */
export interface AnswerResponse {
  status: 'resumed' | 'recorded' | 'already-answered'
  id: string
  sessionId: string
  kind?: AttentionKind
  remaining?: number
}

/** The routes of the module (spec 26 §2). */
export type HttpAction =
  | 'health'
  | 'session.list'
  | 'session.read'
  | 'session.messages'
  | 'chat'
  | 'chat.resume'
  | 'chat.interrupt'
  | 'attention.list'
  | 'attention.answer'
  | 'activity.stream'
  | 'activity.page'
