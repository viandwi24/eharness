/**
 * OAuth 2.1 helpers with an injected `fetch` and `crypto.subtle`: PKCE (S256), authorization URL
 * with a resource indicator (RFC 8707), code exchange, refresh, protected resource metadata
 * (RFC 9728), authorization server metadata (RFC 8414 / OIDC), dynamic client registration
 * (RFC 7591) and the device authorization grant (RFC 8628).
 *
 * Failures throw `EH_CONFIG_INVALID` with `details.reason` starting with `oauth-`; messages never
 * contain a token, code or client secret.
 *
 * @see docs/specs/24-connectors.md#4-oauth-helpers
 */

import type { OAuthClient, OAuthTokens } from './types.ts'
import { base64url, connectorError, isRecord, randomBytes, sha256 } from './util.ts'

/** Options shared by the helpers that call the network. */
export interface OAuthFetchOptions {
  /** Default `globalThis.fetch`. The app's fetch is where private-network blocking belongs. */
  fetch?: typeof fetch
  signal?: AbortSignal
  now?: () => number
  /** Allow `http://` for hosts other than localhost (tests, private networks). Default `false`. */
  allowInsecure?: boolean
}

/** A PKCE pair. */
export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

/** A code challenge for `verifier` (S256: base64url of its SHA-256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier))
}

/** A fresh PKCE verifier (256 random bits) and its S256 challenge. */
export async function generatePkce(): Promise<Pkce> {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: await pkceChallenge(verifier), method: 'S256' }
}

/** A fresh unguessable OAuth `state` (256 random bits). */
export function generateState(): string {
  return base64url(randomBytes(32))
}

/** Parameters of {@link buildAuthorizationUrl}. */
export interface AuthorizationUrlParams {
  authorizationUrl: string
  clientId: string
  redirectUri: string
  scopes?: readonly string[]
  state: string
  codeChallenge: string
  /** RFC 8707 resource indicator. */
  resource?: string
  /** Extra query parameters (`prompt`, `access_type`, ...). Reserved ones are ignored. */
  extra?: Record<string, string>
}

const RESERVED = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
])

/** The authorization request URL (code flow, S256, optional `resource`). */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  if (params.scopes !== undefined && params.scopes.length > 0) {
    url.searchParams.set('scope', params.scopes.join(' '))
  }
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (params.resource !== undefined) url.searchParams.set('resource', params.resource)
  for (const [key, value] of Object.entries(params.extra ?? {})) {
    if (!RESERVED.has(key)) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** Reject non-HTTPS URLs (except localhost), so discovered endpoints cannot downgrade. */
export function assertSecureUrl(url: string, what: string, options: OAuthFetchOptions = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw connectorError('oauth-url-invalid', `${what} is not a valid URL.`)
  }
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname.endsWith('.localhost')
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && (local || options.allowInsecure === true))
  ) {
    throw connectorError('oauth-url-insecure', `${what} must use https.`)
  }
  return parsed
}

type TokenAuthMethod = 'none' | 'basic' | 'post'

/** Client credentials of a token-endpoint request. */
export interface TokenClientAuth {
  clientId: string
  clientSecret?: string
  /** Default: `'post'` with a secret, else `'none'`. */
  method?: TokenAuthMethod
}

function applyClientAuth(
  headers: Record<string, string>,
  body: URLSearchParams,
  client: TokenClientAuth,
): void {
  const method = client.method ?? (client.clientSecret === undefined ? 'none' : 'post')
  if (method === 'basic' && client.clientSecret !== undefined) {
    const raw = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`
    headers.authorization = `Basic ${btoa(raw)}`
    return
  }
  body.set('client_id', client.clientId)
  if (method === 'post' && client.clientSecret !== undefined) {
    body.set('client_secret', client.clientSecret)
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Throw the OAuth error of a response (`error` / `error_description`), without any secret. */
function oauthFailure(
  what: string,
  response: Response,
  json: Record<string, unknown>,
  secrets: readonly (string | undefined)[],
): never {
  const code = typeof json.error === 'string' ? json.error : undefined
  let description = typeof json.error_description === 'string' ? json.error_description : ''
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 4)
      description = description.split(secret).join('***')
  }
  throw connectorError(
    'oauth-error',
    `${what} failed (HTTP ${response.status}${code === undefined ? '' : `, ${code}`})${description === '' ? '.' : `: ${description.slice(0, 200)}`}`,
    { oauthError: code ?? null, status: response.status },
  )
}

function parseTokens(
  json: Record<string, unknown>,
  now: number,
  previousRefresh?: string,
): OAuthTokens {
  const access = json.access_token
  if (typeof access !== 'string' || access === '') {
    throw connectorError('oauth-error', 'The token response has no access token.')
  }
  const tokens: OAuthTokens = {
    accessToken: access,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
  }
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : previousRefresh
  if (refresh !== undefined && refresh !== '') tokens.refreshToken = refresh
  const expires = typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in)
  if (Number.isFinite(expires) && expires > 0) tokens.expiresAt = now + expires * 1000
  if (typeof json.scope === 'string') tokens.scope = json.scope
  return tokens
}

/** Parameters of {@link exchangeCode}. */
export interface ExchangeCodeParams extends OAuthFetchOptions, TokenClientAuth {
  tokenUrl: string
  code: string
  redirectUri: string
  codeVerifier: string
  resource?: string
}

/** Exchange an authorization code (with the PKCE verifier) for tokens. */
export async function exchangeCode(params: ExchangeCodeParams): Promise<OAuthTokens> {
  assertSecureUrl(params.tokenUrl, 'The token URL', params)
  const doFetch = params.fetch ?? globalThis.fetch
  const now = (params.now ?? Date.now)()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  })
  if (params.resource !== undefined) body.set('resource', params.resource)
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  applyClientAuth(headers, body, params)
  const response = await doFetch(params.tokenUrl, {
    method: 'POST',
    headers,
    body,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  const json = await readJson(response)
  if (!response.ok || typeof json.error === 'string') {
    oauthFailure('The token exchange', response, json, [
      params.code,
      params.clientSecret,
      params.codeVerifier,
    ])
  }
  return parseTokens(json, now)
}

/** Parameters of {@link refreshTokens}. */
export interface RefreshParams extends OAuthFetchOptions, TokenClientAuth {
  tokenUrl: string
  refreshToken: string
  resource?: string
  scopes?: readonly string[]
}

/**
 * Refresh tokens. A response without a new refresh token keeps the old one. A rejected refresh
 * (`invalid_grant`) throws `details.oauthError: 'invalid_grant'`: the person must reconnect.
 */
export async function refreshTokens(params: RefreshParams): Promise<OAuthTokens> {
  assertSecureUrl(params.tokenUrl, 'The token URL', params)
  const doFetch = params.fetch ?? globalThis.fetch
  const now = (params.now ?? Date.now)()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  })
  if (params.resource !== undefined) body.set('resource', params.resource)
  if (params.scopes !== undefined && params.scopes.length > 0) {
    body.set('scope', params.scopes.join(' '))
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  applyClientAuth(headers, body, params)
  const response = await doFetch(params.tokenUrl, {
    method: 'POST',
    headers,
    body,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  const json = await readJson(response)
  if (!response.ok || typeof json.error === 'string') {
    oauthFailure('The token refresh', response, json, [params.refreshToken, params.clientSecret])
  }
  return parseTokens(json, now, params.refreshToken)
}

// -- discovery ----------------------------------------------------------------------------

/** RFC 9728 protected resource metadata (the parts used). */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

/** RFC 8414 / OIDC authorization server metadata (the parts used). */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  device_authorization_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

async function getJson(
  url: string,
  options: OAuthFetchOptions,
): Promise<Record<string, unknown> | undefined> {
  assertSecureUrl(url, 'A discovery URL', options)
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const json = await readJson(response)
  return Object.keys(json).length === 0 ? undefined : json
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined

/** `resource_metadata="<url>"` of a `WWW-Authenticate` header, if present. */
export function resourceMetadataFromChallenge(header: string | null): string | undefined {
  if (header === null) return undefined
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1]
}

/**
 * Protected resource metadata of a resource server (RFC 9728): from the `resource_metadata` URL
 * of a 401 challenge when the server sends one, else the well-known URLs (path-inserted, then
 * root). The advertised `resource` must be on the same origin as `resourceUrl`.
 */
export async function discoverProtectedResource(
  resourceUrl: string,
  options: OAuthFetchOptions = {},
): Promise<ProtectedResourceMetadata | undefined> {
  const target = assertSecureUrl(resourceUrl, 'The resource URL', options)
  const candidates: string[] = []
  const doFetch = options.fetch ?? globalThis.fetch
  try {
    const probe = await doFetch(target.toString(), {
      method: 'GET',
      headers: { accept: 'application/json, text/event-stream' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const advertised = resourceMetadataFromChallenge(probe.headers.get('www-authenticate'))
    if (advertised !== undefined) candidates.push(new URL(advertised, target).toString())
    await probe.body?.cancel().catch(() => undefined)
  } catch {
    // an unreachable probe falls through to the well-known URLs
  }
  const path = target.pathname.replace(/\/+$/, '')
  if (path !== '') candidates.push(`${target.origin}/.well-known/oauth-protected-resource${path}`)
  candidates.push(`${target.origin}/.well-known/oauth-protected-resource`)
  for (const url of candidates) {
    const json = await getJson(url, options)
    if (json === undefined || typeof json.resource !== 'string') continue
    let origin: string
    try {
      origin = new URL(json.resource).origin
    } catch {
      continue
    }
    if (origin !== target.origin) {
      throw connectorError(
        'oauth-resource-mismatch',
        'The protected resource metadata names a different server than the one asked about.',
      )
    }
    const servers = strings(json.authorization_servers)
    const scopes = strings(json.scopes_supported)
    return {
      resource: json.resource,
      ...(servers === undefined ? {} : { authorization_servers: servers }),
      ...(scopes === undefined ? {} : { scopes_supported: scopes }),
    }
  }
  return undefined
}

/**
 * Authorization server metadata (RFC 8414, then OpenID discovery), checking `issuer` and that
 * PKCE S256 is supported when the server lists its methods.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  options: OAuthFetchOptions = {},
): Promise<AuthorizationServerMetadata> {
  const base = assertSecureUrl(issuer, 'The issuer URL', options)
  const path = base.pathname.replace(/\/+$/, '')
  const urls = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    ...(path === '' ? [] : [`${base.origin}${path}/.well-known/openid-configuration`]),
  ]
  for (const url of urls) {
    const json = await getJson(url, options)
    if (json === undefined) continue
    const { authorization_endpoint: auth, token_endpoint: token, issuer: iss } = json
    if (typeof auth !== 'string' || typeof token !== 'string') continue
    if (typeof iss === 'string' && iss.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
      throw connectorError(
        'oauth-issuer-mismatch',
        'The authorization server reports another issuer.',
      )
    }
    const methods = strings(json.code_challenge_methods_supported)
    if (methods !== undefined && !methods.includes('S256')) {
      throw connectorError('oauth-no-pkce', 'The authorization server does not support PKCE S256.')
    }
    assertSecureUrl(auth, 'The authorization endpoint', options)
    assertSecureUrl(token, 'The token endpoint', options)
    const meta: AuthorizationServerMetadata = {
      issuer: typeof iss === 'string' ? iss : issuer,
      authorization_endpoint: auth,
      token_endpoint: token,
    }
    if (typeof json.registration_endpoint === 'string') {
      meta.registration_endpoint = assertSecureUrl(
        json.registration_endpoint,
        'The registration endpoint',
        options,
      ).toString()
    }
    if (typeof json.device_authorization_endpoint === 'string') {
      meta.device_authorization_endpoint = json.device_authorization_endpoint
    }
    const scopes = strings(json.scopes_supported)
    if (scopes !== undefined) meta.scopes_supported = scopes
    if (methods !== undefined) meta.code_challenge_methods_supported = methods
    const authMethods = strings(json.token_endpoint_auth_methods_supported)
    if (authMethods !== undefined) meta.token_endpoint_auth_methods_supported = authMethods
    return meta
  }
  throw connectorError(
    'oauth-discovery-failed',
    `No authorization server metadata found for ${base.origin}.`,
  )
}

/** What MCP discovery found. */
export interface McpAuthorization {
  /** The resource indicator to send (RFC 8707). */
  resource: string
  server: AuthorizationServerMetadata
  scopes?: string[]
}

/**
 * Discover how to authorize against a remote MCP server: protected resource metadata, then the
 * first authorization server (a server without resource metadata is treated as its own
 * authorization server, as older MCP servers are).
 */
export async function discoverMcpAuthorization(
  serverUrl: string,
  options: OAuthFetchOptions = {},
): Promise<McpAuthorization> {
  const target = assertSecureUrl(serverUrl, 'The MCP server URL', options)
  const resource = await discoverProtectedResource(serverUrl, options)
  const issuer = resource?.authorization_servers?.[0] ?? target.origin
  const server = await discoverAuthorizationServer(issuer, options)
  const out: McpAuthorization = {
    resource: resource?.resource ?? `${target.origin}${target.pathname.replace(/\/+$/, '')}`,
    server,
  }
  if (resource?.scopes_supported !== undefined) out.scopes = resource.scopes_supported
  return out
}

// -- dynamic client registration ----------------------------------------------------------

/** Parameters of {@link registerClient}. */
export interface RegisterClientParams extends OAuthFetchOptions {
  registrationEndpoint: string
  clientName: string
  redirectUris: string[]
  scopes?: readonly string[]
}

/** Register a public client (RFC 7591): authorization code and refresh grants, no secret. */
export async function registerClient(params: RegisterClientParams): Promise<OAuthClient> {
  assertSecureUrl(params.registrationEndpoint, 'The registration endpoint', params)
  const doFetch = params.fetch ?? globalThis.fetch
  const response = await doFetch(params.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: params.clientName,
      redirect_uris: params.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(params.scopes === undefined || params.scopes.length === 0
        ? {}
        : { scope: params.scopes.join(' ') }),
    }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  const json = await readJson(response)
  if (!response.ok || typeof json.client_id !== 'string') {
    throw connectorError(
      'oauth-registration-failed',
      `Client registration failed (HTTP ${response.status}).`,
      {
        status: response.status,
      },
    )
  }
  const client: OAuthClient = { clientId: json.client_id, dynamic: true }
  if (typeof json.client_secret === 'string' && json.client_secret !== '') {
    client.clientSecret = json.client_secret
  }
  if (typeof json.client_secret_expires_at === 'number' && json.client_secret_expires_at > 0) {
    client.clientSecretExpiresAt = json.client_secret_expires_at * 1000
  }
  return client
}

// -- device authorization grant ------------------------------------------------------------

/** A started device authorization. */
export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUrl: string
  verificationUrlComplete?: string
  /** Epoch ms. */
  expiresAt: number
  /** Minimum poll interval in ms. */
  intervalMs: number
}

/** Parameters of {@link requestDeviceCode}. */
export interface DeviceCodeParams extends OAuthFetchOptions {
  deviceAuthorizationUrl: string
  clientId: string
  scopes?: readonly string[]
}

/** Start a device authorization (RFC 8628 §3.1). */
export async function requestDeviceCode(params: DeviceCodeParams): Promise<DeviceAuthorization> {
  assertSecureUrl(params.deviceAuthorizationUrl, 'The device authorization URL', params)
  const doFetch = params.fetch ?? globalThis.fetch
  const now = (params.now ?? Date.now)()
  const body = new URLSearchParams({ client_id: params.clientId })
  if (params.scopes !== undefined && params.scopes.length > 0)
    body.set('scope', params.scopes.join(' '))
  const response = await doFetch(params.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  const json = await readJson(response)
  if (!response.ok || typeof json.error === 'string') {
    oauthFailure('The device authorization', response, json, [])
  }
  const url = json.verification_uri ?? json.verification_url
  if (
    typeof json.device_code !== 'string' ||
    typeof json.user_code !== 'string' ||
    typeof url !== 'string'
  ) {
    throw connectorError('oauth-error', 'The device authorization response is incomplete.')
  }
  const expires = typeof json.expires_in === 'number' ? json.expires_in : 900
  const interval = typeof json.interval === 'number' && json.interval > 0 ? json.interval : 5
  const out: DeviceAuthorization = {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUrl: url,
    expiresAt: now + expires * 1000,
    intervalMs: interval * 1000,
  }
  if (typeof json.verification_uri_complete === 'string') {
    out.verificationUrlComplete = json.verification_uri_complete
  }
  return out
}

/** Outcome of one device token poll. */
export type DevicePollResult =
  | { status: 'pending'; intervalMs: number }
  | { status: 'authorized'; tokens: OAuthTokens }
  | { status: 'denied' }
  | { status: 'expired' }

/** Parameters of {@link pollDeviceToken}. */
export interface DevicePollParams extends OAuthFetchOptions {
  tokenUrl: string
  clientId: string
  clientSecret?: string
  deviceCode: string
  /** The interval in force; `slow_down` adds 5 s to it (RFC 8628 §3.5). */
  intervalMs: number
}

/** One poll of the token endpoint during a device authorization (the caller waits between polls). */
export async function pollDeviceToken(params: DevicePollParams): Promise<DevicePollResult> {
  assertSecureUrl(params.tokenUrl, 'The token URL', params)
  const doFetch = params.fetch ?? globalThis.fetch
  const now = (params.now ?? Date.now)()
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: params.deviceCode,
    client_id: params.clientId,
  })
  if (params.clientSecret !== undefined) body.set('client_secret', params.clientSecret)
  const response = await doFetch(params.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  const json = await readJson(response)
  if (response.ok && typeof json.error !== 'string') {
    return { status: 'authorized', tokens: parseTokens(json, now) }
  }
  switch (json.error) {
    case 'authorization_pending':
      return { status: 'pending', intervalMs: params.intervalMs }
    case 'slow_down':
      return { status: 'pending', intervalMs: params.intervalMs + 5000 }
    case 'access_denied':
      return { status: 'denied' }
    case 'expired_token':
      return { status: 'expired' }
    default:
      return oauthFailure('The device token request', response, json, [
        params.deviceCode,
        params.clientSecret,
      ])
  }
}
