/**
 * Access tokens for connections: `getAccessToken` that refreshes under a lock and marks the
 * connection `needs-auth` when the refresh token is rejected. Tokens live in the
 * {@link CredentialStore}, apart from the settings, so a refresh never rewrites a connection.
 *
 * @see docs/specs/24-connectors.md#4-oauth-helpers
 */
import { refreshTokens } from './oauth.ts'
import type {
  ConnectionCredentials,
  ConnectionStore,
  CredentialStore,
  OAuthNetworkOptions,
} from './types.ts'
import { connectorError } from './util.ts'

/**
 * Serializes work per key. The default is per process; pass a distributed lock (a database row
 * or advisory lock) when several instances can refresh the same connection: refresh tokens are
 * often single-use, so two parallel refreshes can lose the connection.
 */
export type RefreshLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>

/** A per-process {@link RefreshLock}. */
export function inMemoryRefreshLock(): RefreshLock {
  const tails = new Map<string, Promise<unknown>>()
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

/** Options of {@link createCredentialManager}. */
export interface CredentialManagerOptions {
  credentials: CredentialStore
  /** Used to mark a connection `needs-auth` when its refresh token is rejected. */
  connections?: ConnectionStore
  fetch?: typeof fetch
  now?: () => number
  lock?: RefreshLock
  /** Refresh this long before expiry. Default 60 s. */
  skewMs?: number
  /** Default 15 000 — limit of the refresh request; the `refresh:<id>` lock is held at most this long. */
  timeoutMs?: number
  /** Network policy of the refresh request (private hosts, response size). */
  oauth?: OAuthNetworkOptions
}

/** Hands out fresh access tokens. */
export interface CredentialManager {
  /**
   * A valid access token, refreshed when it expires (or is about to). Rejects with
   * `EH_CONFIG_INVALID` (`details.reason: 'needs-auth'`) when there are no credentials or the
   * refresh token was rejected: the person must reconnect.
   */
  getAccessToken(connectionId: string): Promise<string>
}

/** Create a {@link CredentialManager}. */
export function createCredentialManager(options: CredentialManagerOptions): CredentialManager {
  const now = options.now ?? Date.now
  const skew = options.skewMs ?? 60_000
  const lock = options.lock ?? inMemoryRefreshLock()
  const fresh = (
    c: ConnectionCredentials | undefined,
  ): c is ConnectionCredentials & { tokens: NonNullable<ConnectionCredentials['tokens']> } =>
    c?.tokens !== undefined &&
    (c.tokens.expiresAt === undefined || c.tokens.expiresAt - skew > now())

  async function needsAuth(connectionId: string, why: string): Promise<never> {
    const record = await options.connections?.get(connectionId)
    if (record !== undefined && record.status !== 'needs-auth') {
      await options.connections?.put({
        ...record,
        status: 'needs-auth',
        statusMessage: 'Reconnect required.',
        updatedAt: now(),
      })
    }
    throw connectorError('needs-auth', why, { connectionId })
  }

  return {
    async getAccessToken(connectionId) {
      const first = await options.credentials.get(connectionId)
      if (first?.tokens === undefined) {
        throw connectorError('needs-auth', 'The connection has no credentials; connect it first.', {
          connectionId,
        })
      }
      if (fresh(first)) return first.tokens.accessToken
      return lock(`refresh:${connectionId}`, async () => {
        // another caller (or instance) may have refreshed while this one waited
        const current = await options.credentials.get(connectionId)
        if (fresh(current)) return current.tokens.accessToken
        const refreshToken = current?.tokens?.refreshToken
        if (
          current === undefined ||
          refreshToken === undefined ||
          current.client === undefined ||
          current.endpoints === undefined
        ) {
          return needsAuth(
            connectionId,
            'The access token expired and cannot be refreshed; reconnect.',
          )
        }
        try {
          const tokens = await refreshTokens({
            tokenUrl: current.endpoints.tokenUrl,
            clientId: current.client.clientId,
            ...(current.client.clientSecret === undefined
              ? {}
              : { clientSecret: current.client.clientSecret }),
            ...(current.endpoints.clientAuth === undefined
              ? {}
              : { method: current.endpoints.clientAuth }),
            refreshToken,
            ...(current.endpoints.resource === undefined
              ? {}
              : { resource: current.endpoints.resource }),
            ...options.oauth,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            now,
          })
          await options.credentials.put(connectionId, { ...current, tokens })
          return tokens.accessToken
        } catch (error) {
          const details = (error as { details?: { oauthError?: unknown } }).details
          if (details?.oauthError === 'invalid_grant' || details?.oauthError === 'invalid_client') {
            return needsAuth(connectionId, 'The refresh token was rejected; reconnect.')
          }
          throw error
        }
      })
    },
  }
}
