/**
 * `createHarnessHttp`: the route table, routing and the common pipeline (authorize, run, map
 * errors). Web APIs only: `Request` in, `Response` out.
 *
 * @see docs/specs/26-http.md
 */
import { type HarnessAgent, HarnessError } from '../index.ts'
import { handleActivityPageRoute, handleActivityStreamRoute } from './activity.ts'
import { handleAttentionAnswer, handleAttentionList } from './attention.ts'
import { denialOf } from './authorize.ts'
import { DEFAULT_MAX_BODY_BYTES } from './body.ts'
import { handleChat, handleInterrupt, handleResume } from './chat.ts'
import { httpError, mapError } from './errors.ts'
import {
  handleHealth,
  handleSessionList,
  handleSessionMessage,
  handleSessionMessages,
  handleSessionRead,
} from './sessions.ts'
import type {
  HarnessHttp,
  HarnessHttpOptions,
  HttpCall,
  HttpEnv,
  HttpMatch,
  HttpRoute,
} from './types.ts'
import type { HttpAction } from './wire.ts'

type Handler<P> = (env: HttpEnv<P>, call: HttpCall<P>) => Promise<Response>

interface RouteDef<P> extends HttpRoute {
  /** The route exists only when this holds for the configured options. */
  when: (env: HttpEnv<P>) => boolean
  run: Handler<P>
}

function table<P>(): RouteDef<P>[] {
  return [
    { method: 'GET', path: '/health', action: 'health', when: () => true, run: handleHealth },
    {
      method: 'GET',
      path: '/sessions',
      action: 'session.list',
      when: (e) => e.options.sessions !== undefined,
      run: handleSessionList,
    },
    {
      method: 'GET',
      path: '/sessions/:id',
      action: 'session.read',
      when: (e) => e.peek !== undefined,
      run: handleSessionRead,
    },
    {
      method: 'GET',
      path: '/sessions/:id/messages',
      action: 'session.messages',
      when: (e) => e.peek !== undefined,
      run: handleSessionMessages,
    },
    {
      method: 'GET',
      path: '/sessions/:id/messages/:messageId',
      action: 'session.message',
      when: (e) => e.peek !== undefined,
      run: handleSessionMessage,
    },
    {
      method: 'POST',
      path: '/sessions/:id/chat',
      action: 'chat',
      when: (e) => e.session !== undefined,
      run: handleChat,
    },
    {
      method: 'GET',
      path: '/sessions/:id/chat/stream',
      action: 'chat.resume',
      when: (e) => e.session !== undefined,
      run: handleResume,
    },
    {
      method: 'POST',
      path: '/sessions/:id/interrupt',
      action: 'chat.interrupt',
      when: (e) => e.session !== undefined,
      run: handleInterrupt,
    },
    {
      method: 'GET',
      path: '/attention',
      action: 'attention.list',
      when: (e) => e.options.attention !== undefined,
      run: handleAttentionList,
    },
    {
      method: 'POST',
      path: '/attention/:id/answer',
      action: 'attention.answer',
      when: (e) => e.options.attention !== undefined,
      run: handleAttentionAnswer,
    },
    {
      method: 'GET',
      path: '/activity/stream',
      action: 'activity.stream',
      when: (e) => e.options.activity !== undefined,
      run: handleActivityStreamRoute,
    },
    {
      method: 'GET',
      path: '/activity',
      action: 'activity.page',
      when: (e) => e.options.activity !== undefined,
      run: handleActivityPageRoute,
    },
  ]
}

function normalizeBase(base: string | undefined): string {
  if (base === undefined || base === '' || base === '/') return ''
  const withSlash = base.startsWith('/') ? base : `/${base}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

/** Segments of the path below `base`, decoded; `null` when the path is outside it or malformed. */
function segmentsOf(request: Request, base: string): string[] | null {
  let path = new URL(request.url).pathname
  if (base !== '') {
    if (path !== base && !path.startsWith(`${base}/`)) return null
    path = path.slice(base.length)
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  const parts = path.split('/').slice(1)
  try {
    return parts.map((p) => decodeURIComponent(p))
  } catch {
    return null
  }
}

function matchPath(pattern: string, segments: string[]): Record<string, string> | null {
  const want = pattern.split('/').slice(1)
  if (want.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string
    const got = segments[i] as string
    if (w.startsWith(':')) {
      if (got === '') return null
      params[w.slice(1)] = got
    } else if (w !== got) return null
  }
  return params
}

/**
 * Create the HTTP module of an agent: chat (a `useChat` endpoint with resume, steering,
 * interrupt), session reads, the attention queue and the activity feed, behind one `authorize`.
 * See spec 26 for the routes and the guarantees.
 *
 * @example
 * ```ts
 * const http = createHarnessHttp(agent, { authorize: async ({ request }) => userOf(request) ?? { deny: 401 } })
 * export default { fetch: http.fetch }
 * ```
 * @see docs/specs/26-http.md
 */
export function createHarnessHttp<P extends object = object>(
  agent: HarnessAgent | undefined,
  options: HarnessHttpOptions<P>,
): HarnessHttp {
  if (typeof options?.authorize !== 'function') {
    throw new HarnessError('EH_CONFIG_INVALID', 'createHarnessHttp: `authorize` is required.')
  }
  const base = normalizeBase(options.basePath)
  const sessionHook = options.session
  const peekHook = options.peek
  const env: HttpEnv<P> = {
    options,
    boot: options.activity?.bootId ?? crypto.randomUUID(),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    session:
      sessionHook !== undefined
        ? async (id, ctx) => sessionHook(id, ctx)
        : agent !== undefined
          ? async (id) => agent.session(id) as never
          : undefined,
    peek:
      peekHook !== undefined
        ? async (id, ctx) => peekHook(id, ctx)
        : agent !== undefined
          ? async (id) => agent.peek(id) as never
          : undefined,
  }
  const defs = table<P>().filter((d) => d.when(env))
  const routes: HttpRoute[] = defs.map(({ method, path, action }) => ({
    method,
    path: `${base}${path}`,
    action,
  }))

  const finalize = (response: Response): Response => {
    if (options.headers === undefined) return response
    const headers = new Headers(response.headers)
    for (const [k, v] of new Headers(options.headers)) headers.set(k, v)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  const fail = async (
    error: unknown,
    request: Request,
    action: HttpAction | undefined,
  ): Promise<Response> => {
    const call = { request, ...(action === undefined ? {} : { action }) }
    if (options.onError !== undefined) {
      try {
        const mapped = await options.onError(error, call)
        if (mapped !== undefined) return mapped
      } catch (hookError) {
        error = hookError
      }
    }
    const { response, failure } = mapError(error)
    if (failure) {
      try {
        options.onFailure?.(error, call)
      } catch {
        // an observer must not change the answer
      }
    }
    return response
  }

  const run = async (
    def: RouteDef<P>,
    request: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    try {
      const sessionRoute = def.path.startsWith('/sessions/')
      const result = await options.authorize({
        request,
        action: def.action,
        ...(sessionRoute && params.id !== undefined ? { sessionId: params.id } : {}),
        ...(def.action === 'attention.answer' && params.id !== undefined
          ? { attentionId: params.id }
          : {}),
      })
      const denied = denialOf(result)
      if (denied !== undefined) return finalize(denied)
      return finalize(
        await def.run(env, { request, principal: result as P, action: def.action, params }),
      )
    } catch (error) {
      return finalize(await fail(error, request, def.action))
    }
  }

  const find = (request: Request): { def: RouteDef<P>; params: Record<string, string> } | null => {
    const segments = segmentsOf(request, base)
    if (segments === null) return null
    for (const def of defs) {
      if (def.method !== request.method) continue
      const params = matchPath(def.path, segments)
      if (params !== null) return { def, params }
    }
    return null
  }

  const handlers = {} as HarnessHttp['handlers']
  const actions: HttpAction[] = [
    'health',
    'session.list',
    'session.read',
    'session.messages',
    'session.message',
    'chat',
    'chat.resume',
    'chat.interrupt',
    'attention.list',
    'attention.answer',
    'activity.stream',
    'activity.page',
  ]
  for (const action of actions) {
    const def = defs.find((d) => d.action === action)
    handlers[action] =
      def === undefined
        ? async () => finalize(httpError('EH_HTTP_NOT_FOUND', 'Not found.'))
        : (request, params = {}) => run(def, request, params)
  }

  return {
    routes,
    match(request): HttpMatch | null {
      const found = find(request)
      return found === null ? null : { action: found.def.action, params: found.params }
    },
    handlers,
    async fetch(request) {
      try {
        const found = find(request)
        if (found !== null) return await run(found.def, request, found.params)
        const segments = segmentsOf(request, base)
        const allowed =
          segments === null
            ? []
            : [
                ...new Set(
                  defs.filter((d) => matchPath(d.path, segments) !== null).map((d) => d.method),
                ),
              ]
        if (allowed.length > 0) {
          const response = httpError('EH_HTTP_METHOD_NOT_ALLOWED', 'Method not allowed.', {
            allow: allowed,
          })
          response.headers.set('allow', allowed.join(', '))
          return finalize(response)
        }
        return finalize(httpError('EH_HTTP_NOT_FOUND', 'Not found.'))
      } catch (error) {
        return finalize(await fail(error, request, undefined))
      }
    },
  }
}
