/**
 * In-flight logins of the "Telegram account" connector.
 *
 * A login is several HTTP requests (phone, code, password, QR polls) but one MTProto client: the
 * client holds a half-made auth key and the code hash. The flow's sealed scratch cannot carry a
 * live client, so it is kept here, per flow id, with a time to live, and disposed when the flow
 * ends or the TTL passes.
 *
 * **Single process.** The registry is in memory: every request of one login must reach the process
 * that started it (one server process, or sticky routing). That is the same rule as the account
 * runtime itself, which needs exactly one live client per session.
 *
 * The 2FA password only ever passes through memory: it is handed to the client and dropped. It is
 * never written to the flow scratch, the database or a log.
 */
import type { TgClientFactory, TgUser, TgUserClient } from './client.ts'

export interface QrState {
  url: string
  expiresAt: number
  scanned: boolean
  /** The account has 2FA and waits for the password. */
  needPassword: boolean
  /** The last password was wrong. */
  badPassword: boolean
  user?: TgUser
  error?: unknown
}

export interface LoginSession {
  flowId: string
  client: TgUserClient
  expiresAt: number
  phone?: string
  phoneCodeHash?: string
  /** What the last code request said ("app", "sms", ...). */
  codeType?: string
  /** `signIn` asked for the 2FA password. */
  needPassword: boolean
  user?: TgUser
  qr?: QrState & { abort: AbortController; waiter?: (password: string) => void }
}

export interface LoginSessions {
  /** Create the client of a flow (a second call of the same flow returns the same session). */
  open(flowId: string, app: { apiId: number; apiHash: string }): LoginSession
  get(flowId: string): LoginSession | undefined
  /** Start the QR login of a session (idempotent). */
  startQr(flowId: string): void
  /** Give the QR login the 2FA password (kept in memory only). */
  submitQrPassword(flowId: string, password: string): void
  /** Stop and forget a login. */
  dispose(flowId: string): Promise<void>
  /** Dispose logins past their time to live. */
  sweep(): Promise<void>
  size(): number
}

export interface LoginSessionsOptions {
  factory: () => TgClientFactory
  ttlMs?: number
  now?: () => number
}

export function createLoginSessions(options: LoginSessionsOptions): LoginSessions {
  const ttl = options.ttlMs ?? 20 * 60_000
  const now = options.now ?? (() => Date.now())
  const sessions = new Map<string, LoginSession>()

  const dispose = async (flowId: string): Promise<void> => {
    const s = sessions.get(flowId)
    if (s === undefined) return
    sessions.delete(flowId)
    s.qr?.abort.abort()
    s.qr?.waiter?.('')
    await s.client.stop().catch(() => undefined)
  }

  return {
    open(flowId, app) {
      const existing = sessions.get(flowId)
      if (existing !== undefined) {
        existing.expiresAt = now() + ttl
        return existing
      }
      const session: LoginSession = {
        flowId,
        client: options.factory()({ apiId: app.apiId, apiHash: app.apiHash }),
        expiresAt: now() + ttl,
        needPassword: false,
      }
      sessions.set(flowId, session)
      return session
    },
    get(flowId) {
      const s = sessions.get(flowId)
      if (s !== undefined) s.expiresAt = now() + ttl
      return s
    },
    startQr(flowId) {
      const s = sessions.get(flowId)
      if (s === undefined || s.qr !== undefined) return
      const abort = new AbortController()
      const qr: NonNullable<LoginSession['qr']> = {
        url: '',
        expiresAt: 0,
        scanned: false,
        needPassword: false,
        badPassword: false,
        abort,
      }
      s.qr = qr
      void s.client
        .signInQr({
          signal: abort.signal,
          onUrl: (url, expiresAt) => {
            qr.url = url
            qr.expiresAt = expiresAt
          },
          onScanned: () => {
            qr.scanned = true
          },
          password: () =>
            new Promise<string>((resolve) => {
              qr.needPassword = true
              qr.badPassword = false
              qr.waiter = (password) => {
                qr.needPassword = false
                qr.waiter = undefined
                resolve(password)
              }
            }),
          onBadPassword: () => {
            qr.badPassword = true
          },
        })
        .then((user) => {
          qr.user = user
          s.user = user
        })
        .catch((error) => {
          if (!abort.signal.aborted) qr.error = error
        })
    },
    submitQrPassword(flowId, password) {
      const w = sessions.get(flowId)?.qr?.waiter
      w?.(password)
    },
    dispose,
    async sweep() {
      for (const [id, s] of [...sessions]) if (s.expiresAt <= now()) await dispose(id)
    },
    size: () => sessions.size,
  }
}
