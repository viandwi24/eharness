/**
 * Authorization of `eharness/http`: one hook, called before anything else of a route runs.
 *
 * @see docs/specs/26-http.md#4-authorization
 */
import { httpError } from './errors.ts'
import type { HttpAction } from './wire.ts'

type MaybePromise<T> = T | Promise<T>

/** What `authorize` receives. */
export interface AuthorizeCall {
  request: Request
  action: HttpAction
  /** The `:id` of a session route. */
  sessionId?: string
  /** The `:id` of `POST /attention/:id/answer`. */
  attentionId?: string
}

/** A denial: a ready `Response`, or `{ deny }` with a status (401, 403 or 404). */
export type HttpDeny = Response | { deny: 401 | 403 | 404; code?: string; message?: string }

/**
 * Authenticates and authorizes one request. Return the principal (an object, handed to the other
 * hooks) or a denial. A denial is a return value: do not throw for it. A principal object must not
 * have a numeric `deny` key.
 *
 * Fail closed: any result that is neither a `Response`, a `{ deny }` nor an object (`undefined`,
 * `null`, a string, an array) is answered with 401. `authorize: ({ request }) => userOf(request)`
 * therefore denies anonymous callers instead of letting them through; add `?? { deny: 401 }` to
 * choose the message yourself.
 */
export type Authorize<P> = (call: AuthorizeCall) => MaybePromise<P | HttpDeny>

/**
 * Allows everything with an empty principal (`{}`). For local development and tests only: it puts
 * every session, answer and event of the process in front of anyone who can reach the server.
 */
export const openAccess: Authorize<object> = () => ({})

/**
 * The denial a result stands for, as a `Response`; `undefined` when the result is a principal.
 * A result that is not an object (`undefined`, `null`, a primitive, an array) is a 401: the hook
 * forgot to return a principal, and the route must not open (fail closed).
 */
export function denialOf(result: unknown): Response | undefined {
  if (result instanceof Response) return result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return httpError('EH_HTTP_UNAUTHORIZED', 'Authentication is required.', undefined, 401)
  }
  const deny = (result as { deny?: unknown }).deny
  if (deny !== 401 && deny !== 403 && deny !== 404) return undefined
  const { code, message } = result as { code?: unknown; message?: unknown }
  const defaults = {
    401: ['EH_HTTP_UNAUTHORIZED', 'Authentication is required.'],
    403: ['EH_HTTP_FORBIDDEN', 'Not allowed.'],
    404: ['EH_HTTP_NOT_FOUND', 'Not found.'],
  } as const
  const [defaultCode, defaultMessage] = defaults[deny]
  return httpError(
    typeof code === 'string' ? code : defaultCode,
    typeof message === 'string' ? message : defaultMessage,
    undefined,
    deny,
  )
}
