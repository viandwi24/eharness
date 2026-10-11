/**
 * `createHarnessClient`: a typed `fetch` client for the routes of `eharness/http` (spec 26). It
 * owns the base URL, the request headers and credentials, and turns every non-2xx answer into a
 * {@link HarnessHttpError}. Runtime imports: none (types come from `eharness/http`).
 *
 * @see docs/specs/27-client.md#2-createharnessclient
 */
import type { UIMessage } from 'ai'
import type { ActivityPage } from '../activity/index.ts'
import type {
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
  SessionListResponse,
  SessionSnapshot,
} from '../http/index.ts'

/** A value, or a function that returns it (sync or async), resolved on every request. */
export type Resolvable<T> = T | (() => T | Promise<T>)

/** Options of {@link createHarnessClient}. */
export interface HarnessClientOptions {
  /** Where the module is mounted, e.g. `https://api.example.com/api` or `/api`. */
  baseUrl: string
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /**
   * Headers of every request (an `authorization` token goes here); may be a function. A plain
   * record may hold `undefined` values (dropped), so `() => ({ authorization: token ? ... : undefined })`
   * needs no annotation.
   */
  headers?: Resolvable<HeadersInit | Record<string, string | undefined>>
  credentials?: RequestCredentials
}

/** An error answer of the server (`{ error: { code, message, details? } }`) or any non-2xx answer. */
export class HarnessHttpError extends Error {
  readonly status: number
  /** The `code` of the error body; a synthetic code when the answer was not one (a proxy). */
  readonly code: HttpErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(
    status: number,
    code: HttpErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'HarnessHttpError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** The item was answered already (`EH_HTTP_ALREADY_ANSWERED`). */
  get isAlreadyAnswered(): boolean {
    return this.code === 'EH_HTTP_ALREADY_ANSWERED'
  }
  /** The session is busy or closed (`EH_SESSION_BUSY` / `EH_SESSION_CLOSED`). */
  get isBusy(): boolean {
    return this.code === 'EH_SESSION_BUSY' || this.code === 'EH_SESSION_CLOSED'
  }
  /** The message was received already (`EH_HTTP_DUPLICATE_REQUEST`). */
  get isDuplicate(): boolean {
    return this.code === 'EH_HTTP_DUPLICATE_REQUEST'
  }
  /** `404`, e.g. an attention item that is gone. */
  get isNotFound(): boolean {
    return this.status === 404
  }
}

/** Is `error` a {@link HarnessHttpError} (of `code`, when given)? */
export function isHarnessHttpError(
  error: unknown,
  code?: HttpErrorCode,
): error is HarnessHttpError {
  return error instanceof HarnessHttpError && (code === undefined || error.code === code)
}

/** A dropped connection, not a stop the person asked for: the turn may still run on the server. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof HarnessHttpError) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (
    error instanceof TypeError ||
    /failed to fetch|network|load failed|terminated|connection (reset|closed)|socket/i.test(text)
  )
}

/** Read the error of a non-2xx `Response`. */
export async function readHttpError(response: Response): Promise<HarnessHttpError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  const error = (body as Partial<HttpErrorBody> | null | undefined)?.error
  const code = typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`
  const message =
    typeof error?.message === 'string' ? error.message : `Request failed (${response.status})`
  const details =
    typeof error?.details === 'object' && error.details !== null ? error.details : undefined
  return new HarnessHttpError(response.status, code, message, details)
}

/** Options of a JSON call. */
export interface CallOptions {
  signal?: AbortSignal
  /**
   * Extra `fetch` options of this call (`cache`, `keepalive`, `priority`, ...). `method`, `body`
   * and `signal` are owned by the client; `headers` are merged over the client's.
   */
  init?: Omit<RequestInit, 'method' | 'body' | 'signal'>
}

/** Options of {@link SessionsApi.send}. */
export interface ChatSendOptions extends CallOptions {
  ifBusy?: 'reject' | 'steer' | 'wait'
  /** Default: the message id. */
  idempotencyKey?: string
}

/** The result of {@link SessionsApi.send}. */
export type SendResult =
  | { kind: 'queued'; queued: ChatQueued }
  | { kind: 'stream'; response: Response }

/** `/sessions/*` calls. */
export interface SessionsApi {
  list(
    query?: { limit?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<SessionListResponse>
  get(sessionId: string, options?: CallOptions): Promise<SessionSnapshot>
  messages(
    sessionId: string,
    query?: { before?: string; limit?: number },
    options?: CallOptions,
  ): Promise<MessagesPage>
  interrupt(sessionId: string, reason?: string, options?: CallOptions): Promise<InterruptResult>
  /**
   * `POST /sessions/:id/chat` without a chat framework: a `200` answer is the UI message stream
   * (the caller reads or cancels `response.body`), a `202` is `queued`.
   */
  send(sessionId: string, message: UIMessage, options?: ChatSendOptions): Promise<SendResult>
}

/** `/attention*` calls. */
export interface AttentionApi {
  list(options?: CallOptions): Promise<AttentionListResponse>
  /** `Answer` widens the wire answer with the app-defined kinds its `parseAnswer` accepts. */
  answer<Answer = never>(
    attentionId: string,
    request: AnswerRequest<AttentionAnswerWire | Answer>,
    options?: CallOptions,
  ): Promise<AnswerResponse>
}

/** The client of one `eharness/http` mount. */
export interface HarnessClient {
  /** The base URL without a trailing slash. */
  readonly baseUrl: string
  /** `baseUrl` + `path` (`path` starts with `/`). */
  url(path: string, query?: Record<string, string | number | undefined>): string
  /**
   * A raw request to an absolute URL with the client's headers, credentials and `fetch` applied
   * (`init.headers` win). Does not map errors.
   */
  request(url: string, init?: RequestInit): Promise<Response>
  /** `GET /health`; never cached (it is the restart probe), `init` may override. */
  health(options?: CallOptions): Promise<HealthResponse>
  sessions: SessionsApi
  attention: AttentionApi
  activity: {
    page(query?: { after?: number; limit?: number }, options?: CallOptions): Promise<ActivityPage>
  }
}

async function resolve<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === 'function' ? await (value as () => T | Promise<T>)() : value
}

/** `HeadersInit` or a record whose `undefined` values are dropped, as `Headers`. */
function toHeaders(input: HeadersInit | Record<string, string | undefined> | undefined): Headers {
  const headers = new Headers()
  if (input === undefined) return headers
  if (input instanceof Headers || Array.isArray(input)) return new Headers(input)
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) headers.set(key, value)
  }
  return headers
}

/** Create the client of an `eharness/http` mount. */
export function createHarnessClient(options: HarnessClientOptions): HarnessClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')

  const url = (path: string, query?: Record<string, string | number | undefined>): string => {
    let out = `${baseUrl}${path}`
    if (query !== undefined) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const text = params.toString()
      if (text !== '') out += `?${text}`
    }
    return out
  }

  const request = async (target: string, init: RequestInit = {}): Promise<Response> => {
    const headers = toHeaders(await resolve(options.headers))
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    const credentials = init.credentials ?? options.credentials
    const doFetch = options.fetch ?? ((input, i) => globalThis.fetch(input, i))
    return await doFetch(target, {
      ...init,
      headers,
      ...(credentials === undefined ? {} : { credentials }),
    })
  }

  const call = async <T>(
    method: 'GET' | 'POST',
    target: string,
    body?: unknown,
    o?: CallOptions,
    defaults?: RequestInit,
  ): Promise<T> => {
    const signal = o?.signal
    const extra = o?.init
    const response = await request(target, {
      ...defaults,
      ...extra,
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...Object.fromEntries(new Headers(extra?.headers)),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw await readHttpError(response)
    return (await response.json()) as T
  }

  const seg = encodeURIComponent
  const keyOk = /^[A-Za-z0-9_.:-]{1,128}$/

  return {
    baseUrl,
    url,
    request,
    health: (o) => call('GET', url('/health'), undefined, o, { cache: 'no-store' }),
    sessions: {
      list: (query, o) => call('GET', url('/sessions', { ...query }), undefined, o),
      get: (id, o) => call('GET', url(`/sessions/${seg(id)}`), undefined, o),
      messages: (id, query, o) =>
        call('GET', url(`/sessions/${seg(id)}/messages`, { ...query }), undefined, o),
      interrupt: (id, reason, o) =>
        call(
          'POST',
          url(`/sessions/${seg(id)}/interrupt`),
          reason === undefined ? {} : { reason },
          o,
        ),
      async send(id, message, o) {
        const key = o?.idempotencyKey ?? message.id
        const response = await request(url(`/sessions/${seg(id)}/chat`, { ifBusy: o?.ifBusy }), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(keyOk.test(key) ? { 'idempotency-key': key } : {}),
          },
          body: JSON.stringify({
            id,
            messages: [message],
            trigger: 'submit-message',
          }),
          ...(o?.signal === undefined ? {} : { signal: o.signal }),
        })
        if (response.status === 202) {
          return { kind: 'queued', queued: (await response.json()) as ChatQueued }
        }
        if (!response.ok) throw await readHttpError(response)
        return { kind: 'stream', response }
      },
    },
    attention: {
      list: (o) => call('GET', url('/attention'), undefined, o),
      answer: (id, body, o) => call('POST', url(`/attention/${seg(id)}/answer`), body, o),
    },
    activity: {
      page: (query, o) => call('GET', url('/activity', { ...query }), undefined, o),
    },
  }
}
