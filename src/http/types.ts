/**
 * Option and handler types of `eharness/http`.
 *
 * @see docs/specs/26-http.md#6-options
 */
import type {
  ActivityRecord,
  ActivityStore,
  AttentionAnswer,
  AttentionItem,
  AttentionPeekFn,
  AttentionSession,
  ListAttentionOptions,
} from '../activity/index.ts'
import type {
  ApprovalActor,
  ChatRequestOptions,
  ClientToolsOptions,
  HarnessSession,
  PageContextOptions,
  SessionPeek,
} from '../index.ts'
import type { Authorize, HttpDeny } from './authorize.ts'
import type { ChatKind } from './sanitize.ts'
import type { HttpAction, SessionSummary } from './wire.ts'

export type MaybePromise<T> = T | Promise<T>

type JSONRecord = Record<string, import('ai').JSONValue>

/** The context of a hook that runs on behalf of an authorized request. */
export interface SessionCtx<P> {
  principal: P
  request: Request
  action: HttpAction
}

/** Options of the chat routes. */
export interface HttpChatOptions<P> {
  /** Busy policies a client may ask for with `?ifBusy=` (send only). Default `['reject']`. */
  ifBusy?: ReadonlyArray<'reject' | 'steer' | 'wait'>
  /** Policy when `?ifBusy=` is absent. Default `'reject'`. */
  defaultIfBusy?: 'reject' | 'steer' | 'wait'
  /** Accept request-declared client tools (`handleChatRequest`). Default `false`. */
  clientTools?: false | ClientToolsOptions
  /** Accept page context (`handleChatRequest`). Default `false`. */
  pageContext?: false | PageContextOptions
  /** The actor of approval answers, from the principal. */
  actorOf?: (principal: P) => ApprovalActor | undefined
  /** Second authorization, after the body was classified. */
  authorizeKind?: (call: {
    principal: P
    kind: ChatKind
    sessionId: string
    request: Request
  }) => MaybePromise<undefined | HttpDeny>
  /** Server-side `SendOptions` of every turn (`runtime`, `model`, ...). Never read from the body. */
  sendOptions?: (
    ctx: SessionCtx<P>,
  ) => Omit<ChatRequestOptions, 'actor' | 'clientTools' | 'pageContext'>
  /** Parts of a user message. Default 32. */
  maxParts?: number
  /** UTF-8 bytes of one text part. Default 64 KiB. */
  maxTextBytes?: number
}

/** Options of the session routes. */
export interface HttpSessionsOptions<P> {
  /** Backs `GET /sessions`; the route exists only when this is set. */
  list(call: {
    principal: P
    request: Request
    query: { cursor?: string; limit: number }
  }): MaybePromise<{ sessions: SessionSummary[]; next?: string }>
  /** Extra fields of `GET /sessions/:id` (`info`). */
  describe?(
    id: string,
    call: { principal: P; request: Request },
  ): MaybePromise<JSONRecord | undefined>
}

/** What `parseAnswer` may be given of the item the answer is for. */
export interface AttentionTarget {
  id: string
  kind: AttentionItem['kind']
  sessionId: string
  toolCallId: string
  toolName: string
  input: unknown
}

/** Options of the attention routes. */
export interface HttpAttentionOptions<P> {
  /** The sessions to list from (children are walked). Decided by the server, never by the client. */
  roots(call: {
    principal: P
    request: Request
  }): MaybePromise<ReadonlyArray<string | { sessionId: string; agent?: string }>>
  /** A read handle of a session of the walk. */
  peek: AttentionPeekFn
  /** Open the live session that owns an item (to answer it). */
  open(
    sessionId: string,
    call: { principal: P; request: Request },
  ): AttentionSession | Promise<AttentionSession>
  /**
   * May this principal answer an item of `sessionId`? Default: the session is one of the roots or
   * a descendant of one (walks `parentInfo()` up, depth 8). `false` answers 404. "See everything"
   * is an explicit `() => true`.
   */
  canAnswer?(call: {
    principal: P
    request: Request
    sessionId: string
    attentionId: string
  }): MaybePromise<boolean | HttpDeny>
  /** Parse an app-specific answer body into an answer. Throw `EH_INVALID_INPUT` to refuse. */
  parseAnswer?(call: { item?: AttentionTarget; body: unknown }): AttentionAnswer
  /** Include external waits; see `listAttention`. */
  waits?: ListAttentionOptions['waits']
  maxDepth?: number
  /** Emits `attention-answered` when set. */
  store?: ActivityStore
  agentId?: string
  /** Accept `remember` on approval answers. Default `false`. */
  allowRemember?: boolean
  /** Characters of an approval note. Default 2000. */
  maxNoteChars?: number
}

/** Options of the activity routes. */
export interface HttpActivityOptions<P> {
  store: ActivityStore
  /** Id of this server process (sent as the `boot` event and by `/health`). */
  bootId: string
  /** What the principal may see: `'all'` or a predicate over records. */
  filter(principal: P): ((record: ActivityRecord) => boolean) | 'all'
  pollMs?: number
  keepAliveMs?: number
  retryMs?: number
}

/** Options of {@link createHarnessHttp}. */
export interface HarnessHttpOptions<P = unknown> {
  /** Required. Runs before anything else of a route; there is no default. */
  authorize: Authorize<P>
  /** The live session of a request. Default `agent.session(id)`. */
  session?: (id: string, ctx: SessionCtx<P>) => MaybePromise<HarnessSession>
  /** A read handle of a session. Default `agent.peek(id)`. */
  peek?: (id: string, ctx: SessionCtx<P>) => MaybePromise<SessionPeek>
  /** Prefix of every route, e.g. `/api`. Default none. */
  basePath?: string
  /** Largest request body. Default 4 MiB. */
  maxBodyBytes?: number
  chat?: HttpChatOptions<P>
  sessions?: HttpSessionsOptions<P>
  attention?: HttpAttentionOptions<P>
  activity?: HttpActivityOptions<P>
  /** Map an error before the default mapping. Return a `Response` to answer with it. */
  onError?: (
    error: unknown,
    call: { request: Request; action?: HttpAction },
  ) => MaybePromise<Response | undefined>
  /** Observes every 5xx (the response never carries the real error). */
  onFailure?: (error: unknown, call: { request: Request; action?: HttpAction }) => void
  /** Headers added to every response (CORS, for instance). */
  headers?: HeadersInit
}

/** The route table entry. */
export interface HttpRoute {
  method: 'GET' | 'POST'
  /** Relative to `basePath`, `:param` segments. */
  path: string
  action: HttpAction
}

/** A matched route. */
export interface HttpMatch {
  action: HttpAction
  params: Record<string, string>
}

/** The handler object returned by `createHarnessHttp`. */
export interface HarnessHttp {
  /** The whole module as a `fetch` handler: route, authorize, run, answer. Never rejects. */
  fetch(request: Request): Promise<Response>
  /** Which route a request is for (method and path), or `null`. */
  match(request: Request): HttpMatch | null
  /** One handler per route (authorize included, routing excluded). Never reject. */
  handlers: Record<
    HttpAction,
    (request: Request, params?: Record<string, string>) => Promise<Response>
  >
  /** The routes in effect (those whose option is not configured are absent). */
  readonly routes: readonly HttpRoute[]
}

/** What a route handler gets. */
export interface HttpCall<P> {
  request: Request
  principal: P
  action: HttpAction
  params: Record<string, string>
}

/** Shared resolved state of one `createHarnessHttp`. */
export interface HttpEnv<P> {
  options: HarnessHttpOptions<P>
  boot: string
  maxBodyBytes: number
  session: ((id: string, ctx: SessionCtx<P>) => Promise<HarnessSession>) | undefined
  peek: ((id: string, ctx: SessionCtx<P>) => Promise<SessionPeek>) | undefined
}
