/**
 * Optional password login (`BASIC_AUTH_PASSWORD`). Without it nothing here is used.
 *
 * The session is a stateless signed cookie `team_session = <payload>.<signature>`: the payload is
 * `{ iat, exp }` (30 days), the signature HMAC-SHA256 over it. The HMAC key is derived from the
 * password AND the server secret, so changing either one invalidates every session. Because the
 * token holds no server state, logging out only clears the cookie of that browser.
 */

export const SESSION_COOKIE = 'team_session'
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000
/** Failures per client before a lockout starts. */
export const MAX_FAILURES = 5
/** First lockout; it doubles with every further failure up to {@link MAX_LOCKOUT_MS}. */
export const BASE_LOCKOUT_MS = 30_000
export const MAX_LOCKOUT_MS = 15 * 60_000
/** Longest password a login attempt may carry. */
export const MAX_PASSWORD_CHARS = 1024

const enc = new TextEncoder()
const dec = new TextDecoder()

const b64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const unb64url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))

/** Constant-time equality of two equally long byte arrays (unequal lengths are never equal). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export interface LoginOptions {
  /** `BASIC_AUTH_PASSWORD`. */
  password: string
  /** Server secret mixed into the signing key (`TEAM_SECRET_KEY` and the vault key id). */
  secret: string
  now?: () => number
}

export interface LoginAuth {
  /** Constant-time password check (both sides hashed first). */
  checkPassword(given: string): Promise<boolean>
  /** A fresh signed session token and its expiry (ms). */
  issue(): Promise<{ token: string; expiresAt: number }>
  /** True for an untampered, unexpired token signed with the current password and secret. */
  verify(token: string | undefined): Promise<boolean>
}

export function createLoginAuth(options: LoginOptions): LoginAuth {
  const now = options.now ?? Date.now
  const passwordHash = sha256(options.password)
  const key = (async () => {
    const material = await sha256(`team-login-v1\0${options.secret}\0${options.password}`)
    return crypto.subtle.importKey(
      'raw',
      material as Uint8Array<ArrayBuffer>,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
  })()
  const sign = async (data: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('HMAC', await key, enc.encode(data)))

  return {
    async checkPassword(given) {
      return equalBytes(await sha256(given), await passwordHash)
    },
    async issue() {
      const iat = now()
      const expiresAt = iat + SESSION_MS
      const payload = b64url(enc.encode(JSON.stringify({ iat, exp: expiresAt })))
      return { token: `${payload}.${b64url(await sign(payload))}`, expiresAt }
    },
    async verify(token) {
      if (token === undefined || token === '') return false
      const [payload, signature, extra] = token.split('.')
      if (!payload || !signature || extra !== undefined) return false
      try {
        const ok = equalBytes(await sign(payload), unb64url(signature))
        if (!ok) return false
        const body = JSON.parse(dec.decode(unb64url(payload))) as { iat?: unknown; exp?: unknown }
        return typeof body.exp === 'number' && typeof body.iat === 'number' && body.exp > now()
      } catch {
        return false
      }
    },
  }
}

/**
 * In-memory login throttle per client: after {@link MAX_FAILURES} failures the client is locked
 * out, for longer with every further failure. A success forgets the client.
 */
export interface LoginThrottle {
  /** Seconds the client still has to wait, or 0 when it may try. */
  retryAfter(client: string): number
  failure(client: string): void
  success(client: string): void
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const clients = new Map<string, { failures: number; until: number }>()
  const prune = (): void => {
    if (clients.size < 5000) return
    const t = now()
    for (const [k, v] of clients) if (v.until <= t) clients.delete(k)
    // still too many (a flood of distinct clients): drop the oldest half
    if (clients.size >= 5000) {
      let drop = Math.floor(clients.size / 2)
      for (const k of clients.keys()) {
        if (drop-- <= 0) break
        clients.delete(k)
      }
    }
  }
  return {
    retryAfter(client) {
      const c = clients.get(client)
      return c === undefined ? 0 : Math.max(0, Math.ceil((c.until - now()) / 1000))
    },
    failure(client) {
      prune()
      const failures = (clients.get(client)?.failures ?? 0) + 1
      const over = failures - MAX_FAILURES
      const wait = over < 0 ? 0 : Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** over)
      clients.set(client, { failures, until: now() + wait })
    },
    success(client) {
      clients.delete(client)
    },
  }
}
