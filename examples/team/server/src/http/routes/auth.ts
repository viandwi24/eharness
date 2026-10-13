import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  type LoginAuth,
  type LoginThrottle,
  MAX_PASSWORD_CHARS,
  SESSION_COOKIE,
} from '../../app/login.ts'

export interface AuthRouteOptions {
  /** Undefined: login is off (`BASIC_AUTH_PASSWORD` unset). */
  login: LoginAuth | undefined
  throttle: LoginThrottle
  /** The client address (throttle key). */
  clientOf: (c: import('hono').Context) => string
  /** The cookie is `Secure` (the public URL is https, or the request is). */
  secure: (c: import('hono').Context) => boolean
  /** Does a request carry the valid bearer token? */
  bearerOk: (c: import('hono').Context) => boolean
}

const error = (code: string, message: string): { error: { code: string; message: string } } => ({
  error: { code, message },
})

/**
 * `/auth/*`: login, logout and the session probe. Plain handlers (not in the OpenAPI document:
 * they are the web login's own endpoints, see docs/api.md).
 */
export function authRoutes(options: AuthRouteOptions): Hono {
  const { login, throttle } = options
  const app = new Hono()

  app.get('/auth/session', async (c) => {
    if (login === undefined) return c.json({ required: false, authenticated: true })
    const ok = options.bearerOk(c) || (await login.verify(getCookie(c, SESSION_COOKIE)))
    return c.json({ required: true, authenticated: ok })
  })

  app.post('/auth/login', async (c) => {
    if (login === undefined) {
      return c.json(error('LOGIN_DISABLED', 'login is not enabled (BASIC_AUTH_PASSWORD)'), 404)
    }
    const client = options.clientOf(c)
    const wait = throttle.retryAfter(client)
    if (wait > 0) {
      c.header('retry-after', String(wait))
      return c.json(
        error('LOGIN_LOCKED', `Too many failed attempts. Try again in ${formatWait(wait)}.`),
        429,
      )
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(error('INVALID_JSON', 'request body is not valid JSON'), 400)
    }
    const password = (body as { password?: unknown } | null)?.password
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_CHARS) {
      return c.json(error('VALIDATION_ERROR', 'password: expected a string'), 400)
    }
    if (!(await login.checkPassword(password))) {
      throttle.failure(client)
      return c.json(error('INVALID_PASSWORD', 'Wrong password.'), 401)
    }
    throttle.success(client)
    const { token, expiresAt } = await login.issue()
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: options.secure(c),
      expires: new Date(expiresAt),
    })
    return c.json({ ok: true, expiresAt })
  })

  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: options.secure(c) })
    return c.json({ ok: true })
  })

  return app
}

function formatWait(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
}
