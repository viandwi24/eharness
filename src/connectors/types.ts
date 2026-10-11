// biome-ignore-all lint/suspicious/noConfusingVoidType: activate and enter may return nothing
/**
 * Types of `eharness/connectors`: connector definitions, connections, enablement, the setup flow
 * view vocabulary and the ports (stores, vault).
 *
 * @see docs/specs/24-connectors.md
 */
import type { z } from 'zod/v4'
import type { HarnessPlugin, ToolSource } from '../index.ts'
import type {
  ConfigProfile,
  FormField,
  PublicConfigProfile,
  SecretVault,
} from '../providers/index.ts'
import type { OAuthFetchOptions } from './oauth.ts'

export type { SecretVault }

type Awaitable<T> = T | Promise<T>

/** Where a connection lives: the whole workspace, one agent, or (reserved) one user. */
export type ConnectorScope = 'workspace' | 'agent' | 'user'

/** Where a definition comes from. Built-in connectors are the shipped plugins; they are never pinned. */
export type ConnectorSource = 'builtin' | 'curated' | 'custom'

/** What a capability does; decides approval defaults and which `ask` modes are pinned. */
export type CapabilityKind = 'read' | 'write' | 'destructive' | 'external'

/** How the model may use a capability: freely, after a person approves each call, or not at all. */
export type CapabilityMode = 'allow' | 'ask' | 'off'

/** Whether an agent uses a connection: follow its default, or force it on or off. */
export type EnablementState = 'inherit' | 'on' | 'off'

/** A group of tools a person can switch together (Claude-style "Read files", "Edit files"). */
export interface CapabilityDef {
  /** Unique within the connector (`read`, `edit`). */
  id: string
  title: string
  description: string
  kind: CapabilityKind
  /** The connector's own tool names (before any connection prefix). `'*'` is not supported. */
  tools: string[]
  /** Mode when neither the agent nor the connection overrides it. */
  defaultMode: CapabilityMode
}

/** A capability with its resolved mode. */
export interface ResolvedCapability extends CapabilityDef {
  mode: CapabilityMode
}

/** OAuth 2.1 authorization code flow with PKCE (and optional discovery / dynamic registration). */
export interface OAuth2Auth {
  type: 'oauth2'
  /** Admin-supplied OAuth client configuration (zod object with `clientId`, optional `clientSecret`). */
  client?: z.ZodObject
  authorizationUrl?: string
  tokenUrl?: string
  scopes: string[]
  /** Always `true`: PKCE S256 is mandatory. */
  pkce: true
  /** Dynamic client registration (RFC 7591) when no client is configured. Default `'auto'`. */
  dcr?: 'auto' | 'never'
  /** RFC 8707 resource indicator, or a function of the settings. */
  resource?: string | ((settings: Record<string, unknown>) => string | undefined)
  /** `'mcp'`: find the endpoints with RFC 9728 / RFC 8414 discovery from the MCP server URL. */
  discovery?: 'mcp'
  /** MCP server URL for `discovery: 'mcp'`. Default: `settings.url`. */
  serverUrl?: (settings: Record<string, unknown>) => string | undefined
  /** `false` skips the authorization step for these settings (custom MCP with a header token). */
  when?: (settings: Record<string, unknown>) => boolean
  /** How the client authenticates at the token endpoint. Default: `'post'` with a secret, else `'none'`. */
  clientAuth?: 'none' | 'basic' | 'post'
}

/** OAuth 2.0 device authorization grant (RFC 8628). */
export interface DeviceCodeAuth {
  type: 'deviceCode'
  client?: z.ZodObject
  deviceAuthorizationUrl: string
  tokenUrl: string
  scopes: string[]
  when?: (settings: Record<string, unknown>) => boolean
}

/** How a connector authenticates. `apiKey` fields are merged into the settings form. */
export type ConnectorAuth =
  | { type: 'none' }
  | { type: 'apiKey'; fields: z.ZodObject }
  | OAuth2Auth
  | DeviceCodeAuth

/** Per-scope defaults used when a connection is created (see `ensureBuiltinConnections`). */
export interface ScopeDefaults {
  /** Default connection label ("Workspace memory"). */
  label?: string
  /** Inherited by every agent (workspace scope). */
  defaultEnabled?: boolean
  /** Connection-level capability modes. */
  defaultModes?: Record<string, CapabilityMode>
}

/** Fetch and settings handed to `test` and `choose`. */
export interface ConnectorCallContext {
  /** Validated settings (secrets included; never log them). */
  settings: Record<string, unknown>
  /** Choices made so far. */
  choices: Record<string, unknown>
  /** A current access token for OAuth connectors, else `undefined`. */
  accessToken: string | undefined
  fetch: typeof fetch
  signal?: AbortSignal
}

/** Result of a connection test. `message` never contains a secret. */
export interface ConnectorTestResult {
  ok: boolean
  message?: string
  /** Shown as the connected account ("alice@example.com"). */
  accountLabel?: string
  /** Capabilities found at connect time (remote MCP groups tools by their annotations). */
  capabilities?: CapabilityDef[]
}

/** One option of a `choose` view. */
export interface ChooseOption {
  value: string
  label: string
  description?: string
}

/** A selection the person makes while connecting (repositories, workspaces, calendars). */
export interface ChooseSpec {
  /** Key under which the answer is stored in `choices`. */
  key: string
  title: string
  description?: string
  options: ChooseOption[]
  multiple?: boolean
  /** Minimum selections. Default 1 when `options` is not empty. */
  min?: number
}

/** The connection as plugin code sees it. Never serialize it: `settings` holds secrets. */
export interface ConnectionRuntime {
  id: string
  label: string
  scope: ConnectorScope
  scopeId?: string
  accountLabel?: string
  /** A fresh access token (refreshed when it expires); rejects when the person must reconnect. */
  getAccessToken(): Promise<string>
}

/** A connector's remote MCP server, turned into a tool source by the app (`ActivateOptions.mcp`). */
export interface McpSourceSpec {
  kind: 'mcp'
  /** Source name (`^[a-z0-9-]{1,32}$`), usually derived from the connection slug. */
  name: string
  url: string
  /** Static headers (secret values included). */
  headers?: Record<string, string>
  /** Bearer token per request (OAuth connections). */
  getAccessToken?: () => Promise<string>
  /** Allow list of the server's tool names (before prefixing). */
  allow?: string[]
  deny?: string[]
  /** Tool name prefix. Default: the activation's `toolPrefix`. */
  prefix?: string
  defer?: boolean | 'auto'
  /** Trusted risk of the server's tools. */
  risk?: 'read' | 'write' | 'destructive' | 'external'
}

/** What `activate` may contribute. */
export type ConnectorContribution = HarnessPlugin | ToolSource | McpSourceSpec

/** The result of `activate` / `combine`. */
export type ConnectorActivation = ConnectorContribution | ConnectorContribution[] | undefined | void

/** Everything `activate` knows about one active connection. */
export interface ConnectorActivationContext<S extends z.ZodObject = z.ZodObject> {
  connector: { id: string; version: string }
  connection: ConnectionRuntime
  /** Validated settings (the schema's output, auth fields included). Never log them. */
  settings: z.output<S>
  /** Choices of the connection merged under the agent's. */
  choices: Record<string, unknown>
  agent: { id: string }
  /** Mode of every capability (`off` ones included). */
  modes: Record<string, CapabilityMode>
  /** The capabilities that are not `off`, with their modes. */
  capabilities: ResolvedCapability[]
  /** The connector's own names of the tools that are not `off` (before prefixing). */
  tools: string[]
  /** Mode of every tool (per-tool overrides applied). */
  toolModes: Record<string, CapabilityMode>
  /** `''`, or `<connection-slug>_` (see the definition's `toolPrefix` policy). */
  toolPrefix: string
  /** Connection slug (`^[a-z0-9-]{1,32}$`). */
  slug: string
  fetch: typeof fetch
}

/** A setup flow step supplied by a definition. */
export interface FlowStepDef {
  id: string
  /** Skip this step (go to the next) when it returns true. */
  skip?: (ctx: FlowStepContext) => boolean | Promise<boolean>
  /** Run without input right after entering; `advance` is then called with action `'auto'`. */
  auto?: boolean
  /** Runs once when the step is entered. May return an outcome to leave at once. */
  enter?: (ctx: FlowStepContext) => Awaitable<StepOutcome | undefined | void>
  view: (ctx: FlowStepContext) => Awaitable<FlowViewBody>
  advance: (ctx: FlowStepContext, input: StepInput) => Awaitable<StepOutcome>
}

/** Input of {@link FlowStepDef.advance}. */
export interface StepInput {
  action: FlowAction | 'auto' | 'callback'
  data: Record<string, unknown>
}

/** What a step decides. */
export type StepOutcome =
  /** The step after this one. */
  | { next: true }
  /** A step by id, or `'done'`. */
  | { goto: string }
  /** Show this step again, with field errors and/or a message. */
  | { stay: true; errors?: Record<string, string>; message?: string }
  /** Nothing changed (a poll that found nothing yet). */
  | { pending: true }
  /** Show an error view. `retryable` offers a retry of this step. */
  | { error: string; retryable?: boolean }

/** What a flow step can read and write. */
export interface FlowStepContext {
  readonly definition: ConnectorDefinition
  readonly flowId: string
  readonly scope: ConnectorScope
  readonly scopeId: string | undefined
  readonly deps: ResolvedFlowDeps
  /** The merged settings schema (auth fields and settings). */
  readonly schema: z.ZodObject
  /** Sealed scratch space of the flow (JSON; may hold secrets). Never leaves the engine. */
  readonly scratch: Record<string, unknown>
  /** Field errors and message of the last `stay` outcome. */
  readonly notice: { errors?: Record<string, string>; message?: string } | undefined
  /** True when an existing connection is being reconnected. */
  readonly reconnect: boolean
  /** Label of the connection being made or reconnected ("Company docs"), when known. */
  readonly label: string | undefined
  now(): number
}

/** A connector: what it can do, how a person connects it and what it contributes to an agent. */
export interface ConnectorDefinition<S extends z.ZodObject = z.ZodObject> {
  /** Stable id (`^[a-z0-9][a-z0-9-]{0,63}$`). */
  id: string
  version: string
  name: string
  description: string
  /** An icon name or URL the UI resolves. */
  icon?: string
  /** Who makes or runs the service ("GitHub", "Anthropic"); shown on the detail page. */
  publisher?: string
  /** The service's own site (http(s) URL). */
  homepage?: string
  /** Documentation of this connector or its service (http(s) URL). */
  docsUrl?: string
  category: string
  source: ConnectorSource
  /** Scopes a connection of this connector may have. */
  scopes: ConnectorScope[]
  auth: ConnectorAuth
  /** Non-secret and secret settings (zod object, `ehMeta` for form hints). */
  settings?: S
  capabilities: CapabilityDef[]
  /** Static instruction block added to the agent's instructions when a capability is on. */
  instructions?: string
  /** Defaults per scope used when connections are created. */
  scopeDefaults?: Partial<Record<ConnectorScope, ScopeDefaults>>
  /**
   * What to do when an agent has several connections of this connector: `'prefix'` (default)
   * activates each with a connection-slug tool prefix, `'single'` activates only the first
   * (plugins whose tool names are fixed), and `combine` (below) merges them.
   */
  instances?: 'prefix' | 'single'
  /**
   * When tool names get the connection-slug prefix (`<slug>_<tool>`): `'multiple'` (default) only
   * when an agent uses several connections of this connector, `'always'` for every connection
   * (a remote server's tool never shadows another tool and rules always use the same names), and
   * `'never'` for plugins whose tool names are fixed. `ctx.toolPrefix` carries the result.
   */
  toolPrefix?: 'always' | 'multiple' | 'never'
  /** Contribute for one connection. */
  activate?: (ctx: ConnectorActivationContext<S>) => Awaitable<ConnectorActivation>
  /** Contribute once for all connections of this connector an agent uses (merged roots). */
  combine?: (ctxs: ConnectorActivationContext<S>[]) => Awaitable<ConnectorActivation>
  /** Connection test, also run at the end of the connect flow. */
  test?: (ctx: ConnectorCallContext) => Awaitable<ConnectorTestResult>
  /** A selection the person makes while connecting (after authorization, before the test). */
  choose?: (ctx: ConnectorCallContext) => Awaitable<ChooseSpec | undefined>
  /** Replace the default flow steps (a function receives them, to insert or drop steps). */
  flow?: FlowStepDef[] | ((defaults: FlowStepDef[]) => FlowStepDef[])
}

/** A definition with any settings schema. */
// biome-ignore lint/suspicious/noExplicitAny: variance of the settings schema
export type AnyConnectorDefinition = ConnectorDefinition<any>

/** Tokens of an OAuth connection. Stored apart from the settings; never part of a public shape. */
export interface OAuthTokens {
  accessToken: string
  tokenType: string
  refreshToken?: string
  /** Epoch ms. */
  expiresAt?: number
  scope?: string
}

/** The OAuth client a connection uses (admin-configured or dynamically registered). */
export interface OAuthClient {
  clientId: string
  clientSecret?: string
  /** Epoch ms of `client_secret` expiry, when the server said so. */
  clientSecretExpiresAt?: number
  /** `true` when registered with RFC 7591 for this connection. */
  dynamic?: boolean
}

/** Endpoints a connection refreshes tokens with. */
export interface OAuthEndpoints {
  authorizationUrl?: string
  tokenUrl: string
  issuer?: string
  registrationUrl?: string
  deviceAuthorizationUrl?: string
  /** RFC 8707 resource indicator. */
  resource?: string
  clientAuth?: 'none' | 'basic' | 'post'
  scopes?: string[]
}

/** What the credential store keeps per connection. Contains secrets: encrypt it. */
export interface ConnectionCredentials {
  tokens?: OAuthTokens
  client?: OAuthClient
  endpoints?: OAuthEndpoints
  /**
   * An opaque, app-defined session (a Telegram MTProto session string, a cookie jar, ...). The
   * library never reads `data`: a custom flow step sets it (`ctx.scratch.credentials = { session }`),
   * the credential store seals it with the other credentials, and trusted server code reads it
   * through `ConnectorService.credentials`. `format` names how to interpret `data` (for example
   * `'mtcute-string'`), so a runtime can refuse a session it does not understand. Never part of
   * a public view, a flow state or a log line.
   */
  session?: ConnectionSession
}

/** The opaque session slot of {@link ConnectionCredentials}. */
export interface ConnectionSession {
  /** Names how `data` is encoded, e.g. `'mtcute-string'`. */
  format: string
  /** The session itself (a secret). */
  data: string
}

/** Health of a connection. Only `connected` connections are activated. */
export type ConnectionStatus = 'connected' | 'needs-auth' | 'error' | 'disabled'

/**
 * A configured instance of a connector. Extends {@link ConfigProfile} (`kind: 'connection'`), so
 * the generic form machinery (`redactProfile`, `mergeSecretPatch`) applies to it. `settings`
 * contains secrets (API keys, header values): the store adapter must encrypt it. OAuth tokens
 * are not here (see {@link CredentialStore}).
 */
export interface ConnectionRecord extends ConfigProfile {
  kind: 'connection'
  scope: ConnectorScope
  /** The agent id (`agent` scope) or user id (`user` scope). */
  scopeId?: string
  status: ConnectionStatus
  statusMessage?: string
  accountLabel?: string
  /** Workspace/user scope: every agent inherits the connection unless it opts out. */
  defaultEnabled: boolean
  /** Connection-level capability modes (override the definition's defaults). */
  defaultModes?: Record<string, CapabilityMode>
  /** Choices made while connecting (selected repositories, ...). */
  choices?: Record<string, unknown>
  /** Capabilities discovered at connect time; replace the definition's when present. */
  capabilities?: CapabilityDef[]
  /**
   * Stable tool-prefix slug (`^[a-z0-9-]{1,32}$`). When present it is used as the connection slug
   * instead of the slug of the label, so renaming the connection never renames its tools.
   */
  slug?: string
  createdAt: number
}

/** A connection safe to send to a browser: secrets replaced by `{ set, hint? }`. */
export type PublicConnection = PublicConfigProfile<ConnectionRecord> & {
  /** Whether OAuth credentials are stored (never the credentials). */
  authorized: boolean
}

/** One agent's choices for one connection. */
export interface ConnectionEnablement {
  /** Default `'inherit'`. */
  enabled?: EnablementState
  /** Capability modes of this agent. */
  capabilities?: Record<string, CapabilityMode>
  /** Per-tool overrides (the connector's own tool names). */
  tools?: Record<string, CapabilityMode>
  /** Scope choices of this agent (a subset of the connection's repositories, ...). */
  choices?: Record<string, unknown>
}

/** An agent's enablement: connection id to choices. Plain JSON the app persists. */
export type AgentEnablement = Record<string, ConnectionEnablement>

/** Where connections live. The library ships a memory adapter; encrypt `settings` in databases. */
export interface ConnectionStore {
  list(query?: {
    scope?: ConnectorScope
    scopeId?: string
    definitionId?: string
  }): Promise<ConnectionRecord[]>
  get(id: string): Promise<ConnectionRecord | undefined>
  /** Insert or replace by id. */
  put(record: ConnectionRecord): Promise<void>
  /** Idempotent. */
  delete(id: string): Promise<void>
  subscribe?(listener: () => void): () => void
}

/** Where OAuth credentials live, apart from the settings (so a refresh never rewrites them). */
export interface CredentialStore {
  get(connectionId: string): Promise<ConnectionCredentials | undefined>
  put(connectionId: string, credentials: ConnectionCredentials): Promise<void>
  /** Idempotent. */
  delete(connectionId: string): Promise<void>
}

/** Where per-agent enablement lives. */
export interface EnablementStore {
  /** The agent's enablement (empty when none). */
  get(agentId: string): Promise<AgentEnablement>
  /** `undefined` removes the entry. */
  set(agentId: string, connectionId: string, value: ConnectionEnablement | undefined): Promise<void>
  /** Remove a connection from every agent (a connection was deleted). Idempotent. */
  removeConnection(connectionId: string): Promise<void>
  /** Remove an agent's entries. Idempotent. */
  removeAgent(agentId: string): Promise<void>
}

/** What a user is shown, as data. Every view has `viewId` (changes whenever the view changes) and `step`. */
export type FlowView =
  | FormView
  | OAuthView
  | DeviceCodeView
  | QrView
  | ChooseView
  | ConfirmView
  | StatusView
  | ErrorView

/** Common view fields. */
interface ViewBase {
  /** Opaque hash; an action must quote the id of the view it answers. */
  viewId: string
  /** Id of the flow step that produced the view. */
  step: string
}

/** A settings form. Secrets are never echoed: they come back as `{ set, hint? }`. */
export interface FormView extends ViewBase {
  type: 'form'
  title: string
  description?: string
  fields: FormField[]
  /** Current values; secrets as `{ set, hint? }`. */
  values: Record<string, unknown>
  /** Validation errors by field path. */
  errors?: Record<string, string>
  message?: string
  submitLabel: string
}

/** Open `authorizeUrl` (new tab), then poll until the callback arrived. */
export interface OAuthView extends ViewBase {
  type: 'oauth'
  title: string
  authorizeUrl: string
  /** Suggested poll interval; poll with `action: 'poll'`. */
  pollIntervalMs: number
  expiresAt: number
}

/** Show `userCode`, send the person to `verificationUrl`, poll. */
export interface DeviceCodeView extends ViewBase {
  type: 'deviceCode'
  title: string
  userCode: string
  verificationUrl: string
  verificationUrlComplete?: string
  expiresAt: number
  pollIntervalMs: number
}

/**
 * Show `url` as a QR code (the person scans it with another device), then poll. A step may
 * return a new `url` under the same `viewId` (`{ pending: true }` re-renders without a new id),
 * so a login token that rotates every few seconds does not invalidate the UI's action.
 */
export interface QrView extends ViewBase {
  type: 'qr'
  title: string
  description?: string
  /** What the QR code encodes (a `tg://login?token=...` link, a URL). Rotates while polling. */
  url: string
  expiresAt: number
  pollIntervalMs: number
}

/** Choose one or several options. Submit `{ selected: string | string[] }`. */
export interface ChooseView extends ViewBase {
  type: 'choose'
  title: string
  description?: string
  options: ChooseOption[]
  multiple: boolean
  selected: string[]
  min: number
  errors?: Record<string, string>
  message?: string
}

/** Ask for a confirmation (`submit` confirms, `cancel` declines). */
export interface ConfirmView extends ViewBase {
  type: 'confirm'
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
}

/** Progress or the end of a flow. */
export interface StatusView extends ViewBase {
  type: 'status'
  state: 'running' | 'success'
  message: string
  account?: string
}

/** A failure. `retryable` flows accept `action: 'retry'`. */
export interface ErrorView extends ViewBase {
  type: 'error'
  message: string
  retryable: boolean
}

/** A view without `viewId` and `step` (what a step returns). */
export type FlowViewBody = FlowView extends infer V
  ? V extends FlowView
    ? Omit<V, 'viewId' | 'step'>
    : never
  : never

/**
 * What a person can do in a view. `resend` asks a custom step to send a one-time code again (a
 * `form` view may offer it; default steps ignore it).
 */
export type FlowAction = 'submit' | 'poll' | 'back' | 'cancel' | 'retry' | 'resend'

/** Input of `advanceFlow`. */
export interface FlowInput {
  /** The `viewId` of the view being answered. */
  viewId: string
  action: FlowAction
  /** `form`: the values (secrets may be `{ keep: true }`); `choose`: `{ selected }`. */
  data?: Record<string, unknown>
  /** The person acting; required when the flow was started with a `principal`. */
  principal?: string
}

/** Lifecycle of a flow. */
export type FlowStatus = 'active' | 'done' | 'failed' | 'cancelled'

/** A setup flow in progress. Persisted by a {@link FlowStore}; send {@link PublicFlow} to the browser. */
export interface FlowState {
  id: string
  definitionId: string
  scope: ConnectorScope
  scopeId?: string
  label: string
  /** The connection being reconnected. */
  connectionId?: string
  status: FlowStatus
  step: string
  /** Counts view changes; part of the `viewId`. */
  rev: number
  view: FlowView
  createdAt: number
  updatedAt: number
  expiresAt: number
  /** SHA-256 hex of the OAuth `state` while waiting for the callback. */
  stateHash?: string
  /** SHA-256 hex of the principal the flow was started for (see `startFlow`). */
  principalHash?: string
  /** The scratch space, sealed by the {@link SecretVault}. */
  sealed: string
}

/** A flow without its sealed scratch: safe for a browser. */
export type PublicFlow = Omit<FlowState, 'sealed' | 'stateHash'>

/** Result of `advanceFlow`. A failure carries the current state so a UI can re-render. */
export type AdvanceResult =
  | { ok: true; state: FlowState }
  | {
      ok: false
      error: 'stale-view' | 'expired' | 'finished' | 'invalid-action' | 'principal-mismatch'
      message: string
      state: FlowState
    }

/** Where flows live between requests. */
export interface FlowStore {
  get(id: string): Promise<FlowState | undefined>
  put(state: FlowState): Promise<void>
  /** Idempotent. */
  delete(id: string): Promise<void>
  /** The active flow waiting for the OAuth callback with this state hash. */
  findByStateHash(stateHash: string): Promise<FlowState | undefined>
  /** Delete flows whose `expiresAt` is before `now`; returns how many. */
  deleteExpired(now: number): Promise<number>
}

/** What the engine needs from the app. */
export interface FlowDeps {
  /** The definitions a flow may run (a list or a lookup). */
  definitions:
    | readonly AnyConnectorDefinition[]
    | ((id: string) => AnyConnectorDefinition | undefined)
  vault: SecretVault
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch
  now?: () => number
  /** Default `uuidv7`. */
  newId?: () => string
  /** OAuth redirect URI (the app's callback route), or one per definition. */
  redirectUri?: string | ((definitionId: string) => string)
  /**
   * OAuth client configuration of a definition (validated against `auth.client`). The second
   * argument says which flow asks (`flowId`, `scope`, `scopeId`, `reconnect`), so an app can keep
   * per-scope clients or hand out a client entered earlier in the same flow.
   */
  clientConfig?: (
    definitionId: string,
    flow: ClientConfigContext,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  /** Flow lifetime. Default 15 minutes. */
  ttlMs?: number
  /** Network policy of the OAuth requests (private hosts, response size, timeout). */
  oauth?: OAuthNetworkOptions
}

/** The parts of `OAuthFetchOptions` a flow or a credential manager forwards to every request. */
export type OAuthNetworkOptions = Pick<
  OAuthFetchOptions,
  'allowPrivateNetwork' | 'isAllowedUrl' | 'allowInsecure' | 'maxResponseBytes' | 'timeoutMs'
>

/** Which flow asks for an OAuth client configuration (see {@link FlowDeps.clientConfig}). */
export interface ClientConfigContext {
  flowId: string
  scope: ConnectorScope
  scopeId: string | undefined
  reconnect: boolean
  /** The settings of the connection being connected (secrets included: do not send them out). */
  settings: Record<string, unknown>
}

/** {@link FlowDeps} with defaults applied. */
export interface ResolvedFlowDeps {
  definition(id: string): AnyConnectorDefinition | undefined
  vault: SecretVault
  fetch: typeof fetch
  now: () => number
  newId: () => string
  redirectUri(definitionId: string): string | undefined
  clientConfig(
    definitionId: string,
    flow: ClientConfigContext,
  ): Promise<Record<string, unknown> | undefined>
  ttlMs: number
  oauth: OAuthNetworkOptions
}

/** What a finished flow produced (secrets included: save it, do not send it). */
export interface FlowCompletion {
  definitionId: string
  scope: ConnectorScope
  scopeId?: string
  label: string
  connectionId?: string
  /** Settings of the connection (auth fields included). */
  settings: Record<string, unknown>
  choices: Record<string, unknown>
  accountLabel?: string
  capabilities?: CapabilityDef[]
  credentials?: ConnectionCredentials
  /** The `defaultEnabled` the flow was started with. */
  defaultEnabled?: boolean
}

/** What the permissions engine needs, as data (structural: `eharness/permissions` `ToolKinds`). */
export interface ConnectorToolKinds {
  [toolName: string]: { kind: 'other'; alwaysAsk: true }
}

/** Rule strings by decision plus the pinned asks. */
export interface ConnectorRules {
  allow: string[]
  ask: string[]
  deny: string[]
  /** Tools that must ask in every mode, `bypassPermissions` included. */
  pinnedAsk: string[]
  /**
   * `toolKinds` entries (`{ kind: 'other', alwaysAsk: true }`) for the pinned tools: merge them
   * into the permission engine's `toolKinds` and bypass mode cannot skip those asks.
   */
  toolKinds: ConnectorToolKinds
}

/** Where a final tool name came from. */
export interface ToolOrigin {
  connectorId: string
  /** Connections that expose the tool (several with `combine`). */
  connectionIds: string[]
  capabilityId: string
  /** The connector's own name of the tool. */
  tool: string
}

/** A non-fatal problem found while activating. */
export interface ConnectorWarning {
  code:
    | 'unknown-definition'
    | 'connection-unavailable'
    | 'invalid-settings'
    | 'duplicate-instance'
    | 'activate-failed'
    | 'mcp-factory-missing'
  message: string
  connectionId?: string
  connectorId?: string
}

/** One connection that was activated. */
export interface ActiveConnection {
  connectionId: string
  connectorId: string
  slug: string
  toolPrefix: string
  modes: Record<string, CapabilityMode>
}

/** Result of `activateConnectors`. */
export interface ActivatedConnectors {
  /** Plugins in a stable order (builtins first in a fixed order, then by connector id, connection id). */
  plugins: HarnessPlugin[]
  /** MCP and other tool sources, in the same order. */
  mcpSources: ToolSource[]
  rules: ConnectorRules
  /** Static instruction blocks, in the same order. */
  instructions: string[]
  /** Final tool name to origin. */
  toolNameMap: Record<string, ToolOrigin>
  connections: ActiveConnection[]
  warnings: ConnectorWarning[]
}
