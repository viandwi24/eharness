/**
 * Connectors of the team server: `eharness/connectors` over the app's pieces.
 *
 * - ONE secret system: the server's `SecretVault` (`secret-vault.ts`); connections, credentials
 *   and OAuth app credentials are rows of the same `config_profiles` table as provider profiles,
 *   sealed by the one `sealedProfileStore` `compose` builds (this module also seals flow scratch);
 * - flows in `connector_flows`, enablement in `agent_connectors`, the refresh lock in `eh_locks`;
 * - several instances: a change of a connection or of an enablement appends `connectors-changed`;
 *   the others tail the feed and rebuild their agents (token refreshes write credentials only and
 *   append nothing);
 * - `prepare` activates the connectors of agents asynchronously, `activated` hands the result to the
 *   (synchronous) agent factory.
 */
import type { Database } from 'bun:sqlite'
import { isPrivateHost, type SessionLock } from 'eharness'
import {
  type ActivatedConnectors,
  type AgentEnablement,
  type AnyConnectorDefinition,
  activateConnectors,
  type CapabilityKind,
  type ConnectionCredentials,
  type ConnectionRecord,
  capabilitiesOf,
  connectionStoreFromProfiles,
  createConnectorService,
  credentialStoreFromProfiles,
  describeConnector,
  discoverMcpAuthorization,
  ensureBuiltinConnections,
  isConnectionEnabled,
  resolveModes,
} from 'eharness/connectors'
import { listRemoteMcpTools, remoteMcpSource } from 'eharness/mcp'
import type { ProfileStore, SecretVault } from 'eharness/providers'
import type { ConnectorsPort } from '../../app/ports.ts'
import { type AgentDef, TOOL_ACCESS_AUTO_THRESHOLD, type ToolAccess } from '../../domain/agents.ts'
import type {
  AgentConnectorView,
  CapabilityMode,
  ConnectionAccess,
  ConnectionAccessInput,
  ConnectionChoices,
  ConnectionView,
  ConnectorView,
  CustomConnectorInput,
  CustomConnectorResult,
  CustomProbe,
  FlowDto,
  FlowResult,
} from '../../domain/connectors.ts'
import { CUSTOM_DEFINITION, isAllowedMcpUrl, slugOf, uniqueSlug } from '../../domain/connectors.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import type { NewEvent } from '../../domain/events.ts'
import type { CodeRuntime } from '../code/index.ts'
import type { TgClientFactory } from '../telegram-user/client.ts'
import {
  parseTelegramApp,
  TELEGRAM_USER_CONNECTOR_ID,
  type TelegramApp,
} from '../telegram-user/connector.ts'
import { createLoginSessions } from '../telegram-user/login.ts'
import { createMtcuteClient } from '../telegram-user/mtcute-client.ts'
import type { ChangeFeed } from './change-feed.ts'
import { mapConfigError } from './config-errors.ts'
import {
  appRulesOf,
  type CatalogHooks,
  type CatalogOptions,
  createConnectorDefinitions,
} from './connector-catalog.ts'
import { sqliteEnablementStore, sqliteFlowStore, sqliteRefreshLock } from './connector-stores.ts'
import type { LibraryChange } from './library-fs.ts'
import type { ModelConfig } from './provider.ts'

/** Connect and listing limit of every remote MCP server (library default 15 s, set explicitly). */
const MCP_TIMEOUT_MS = 15_000

type Env = Record<string, string | undefined>

/** Rows of the profile table that hold secrets (with the `provider` kind): sealed by `compose`. */
export const SEALED_KINDS = ['connection', 'connection-credentials', 'connector-client'] as const
const CLIENT_KIND = 'connector-client'

export interface ConnectorsOptions {
  sqlite: Database
  /** The sealed profile store (`sealedProfileStore` over `sqliteProfileStore`). */
  profiles: ProfileStore
  /** The server's vault (flow scratch). */
  vault: SecretVault
  lock: SessionLock
  agentById: (id: string) => AgentDef | undefined
  agents: () => AgentDef[]
  search?: ModelConfig['search']
  listTools?: CatalogOptions['listTools']
  onFileChange?: (change: LibraryChange) => void
  env?: Env
  fetch?: typeof fetch
  /** The code sandbox of the Files & Sandbox connector (driver off = files only). */
  code?: CodeRuntime
  /** Resolves a host name to its addresses (custom connector SSRF guard; default: system DNS). */
  resolveHost?: (host: string) => Promise<string[]>
  /** The OAuth callback URL of this server. */
  redirectUri: string
  events?: { append(event: NewEvent): void }
  /** Workspace default tool access (settings); default `auto`. Read on every `prepare`. */
  toolAccess?: () => ToolAccess
  /** Other instances' changes (`connectors-changed`) bump the revision. */
  changes?: ChangeFeed
  /** Id of this instance (its own events are ignored). */
  instance: string
  warn?: (message: string) => void
  /** MTProto client of the "Telegram account" connector (default: mtcute; tests inject a fake). */
  telegramUserClient?: TgClientFactory
  /** QR poll interval and the time a 2FA or QR step waits inside one request (tests shorten them). */
  telegramUserFlow?: { qrPollMs?: number; settleMs?: number }
}

export interface ConnectorsRuntime extends ConnectorsPort {
  hooks: CatalogHooks
  definitions: readonly AnyConnectorDefinition[]
  /** Bumps whenever a connection or an enablement changes on this or another instance. */
  rev(): number
  /**
   * Activate the connectors of these agents (idempotent per agent version and revision). The
   * agent factory is synchronous: call this before `agentFor` / `openSession`.
   */
  prepare(defs: readonly AgentDef[]): Promise<void>
  /** A fresh access token of a connection (server side only; never in a view). */
  accessTokenFor(connectionId: string): Promise<string>
  /** A runtime learned that a credential no longer works (revoked bot token): the connection needs a reconnect. */
  markNeedsAuth(connectionId: string, message?: string): Promise<void>
  /** The stored credentials of a connection, session included (server side only: a long-lived runtime). */
  credentialsOf(connectionId: string): Promise<ConnectionCredentials | undefined>
  /** The workspace's Telegram api_id / api_hash: the environment, else what an admin saved. */
  telegramApp(): Promise<TelegramApp | undefined>
  /** The last activation of an agent, or undefined when it was never prepared. */
  activated(agentId: string): ActivatedConnectors | undefined
  /**
   * The kind of each tool of the last activation of an agent (`read`, `write`, ...), from
   * the capability of its connection. A rehearsal runs the reads for real (an MCP annotation never
   * lowers a risk, so the call's own `risk` cannot say).
   */
  toolKinds(agentId: string): Record<string, CapabilityKind> | undefined
  /** Built-in read tools shown as Allowed: they never ask in Manual mode (see `doPrepare`). */
  readAllowed(agentId: string): ReadonlySet<string> | undefined
  /** A connection row changed locally (called by the profile store hook). */
  profileChanged(kind: string): void
  /** Create the missing built-in connections of these agents. */
  ensureBuiltins(defs: readonly AgentDef[]): Promise<void>
  /** Direct access for the boot migration. */
  stores: {
    connections: ReturnType<typeof connectionStoreFromProfiles>
  }
  close(): void
}

async function lookupAll(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises')
  return (await lookup(host, { all: true })).map((r) => r.address)
}

const envName = (definitionId: string, suffix: string): string =>
  `TEAM_${definitionId.toUpperCase().replaceAll('-', '_')}_${suffix}`

export function createConnectors(options: ConnectorsOptions): ConnectorsRuntime {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const hooks: CatalogHooks = {}
  // `defer` of the remote MCP servers of the agent `doPrepare` is activating (activation is serialized)
  let deferNow: boolean | 'auto' = true
  const telegramLogins = createLoginSessions({
    factory: () => options.telegramUserClient ?? createMtcuteClient(),
  })
  const definitions = createConnectorDefinitions({
    telegramUser: {
      logins: telegramLogins,
      saveApp: (app) => saveTelegramApp(app),
      ...(options.telegramUserFlow?.qrPollMs === undefined
        ? {}
        : { qrPollMs: options.telegramUserFlow.qrPollMs }),
      ...(options.telegramUserFlow?.settleMs === undefined
        ? {}
        : { settleMs: options.telegramUserFlow.settleMs }),
    },
    defer: () => deferNow,
    sqlite: options.sqlite,
    agentById: options.agentById,
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.listTools === undefined ? {} : { listTools: options.listTools }),
    ...(options.onFileChange === undefined ? {} : { onFileChange: options.onFileChange }),
    hooks,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(env.TEAM_TELEGRAM_API_ROOT === undefined
      ? {}
      : { telegramApiRoot: env.TEAM_TELEGRAM_API_ROOT }),
  })
  const defs = new Map(definitions.map((d) => [d.id, d]))
  const vault = options.vault
  const sealed = options.profiles
  const connections = connectionStoreFromProfiles(sealed)
  const credentials = credentialStoreFromProfiles(sealed)
  const flows = sqliteFlowStore(options.sqlite)
  let revision = 0
  const changed = (): void => {
    revision++
    options.events?.append({ type: 'connectors-changed', payload: { instance: options.instance } })
  }
  const enablement = sqliteEnablementStore(options.sqlite, { onChange: changed })

  // OAuth app credentials: the environment wins over what an admin saved from the web
  const clientSource = async (
    id: string,
  ): Promise<{ source: 'env' | 'stored'; value: Record<string, unknown> } | undefined> => {
    const clientId = env[envName(id, 'CLIENT_ID')]
    if (clientId !== undefined && clientId !== '') {
      const secret = env[envName(id, 'CLIENT_SECRET')]
      return {
        source: 'env',
        value: {
          clientId,
          ...(secret === undefined || secret === '' ? {} : { clientSecret: secret }),
        },
      }
    }
    const stored = await sealed.get(CLIENT_KIND, id)
    if (stored !== undefined && typeof stored.settings.clientId === 'string') {
      return { source: 'stored', value: stored.settings }
    }
    return undefined
  }

  /** api_id / api_hash of the Telegram app: the environment wins over what an admin saved from the web. */
  async function telegramApp(): Promise<TelegramApp | undefined> {
    const fromEnv = parseTelegramApp({
      apiId: env.TEAM_TELEGRAM_API_ID,
      apiHash: env.TEAM_TELEGRAM_API_HASH,
    })
    if (fromEnv !== undefined) return fromEnv
    const stored = await sealed.get(CLIENT_KIND, TELEGRAM_USER_CONNECTOR_ID)
    return parseTelegramApp(stored?.settings)
  }
  async function saveTelegramApp(app: TelegramApp): Promise<void> {
    await sealed.put({
      id: TELEGRAM_USER_CONNECTOR_ID,
      kind: CLIENT_KIND,
      definitionId: TELEGRAM_USER_CONNECTOR_ID,
      label: 'Telegram account',
      settings: { apiId: String(app.apiId), apiHash: app.apiHash },
      enabled: true,
      updatedAt: Date.now(),
    })
  }
  /** The one person of this server: the principal that Telegram sign-in flows are bound to. */
  const principalOf = (definitionId: string | undefined): { principal?: string } =>
    definitionId === TELEGRAM_USER_CONNECTOR_ID ? { principal: 'owner' } : {}

  const service = createConnectorService({
    definitions,
    connections,
    credentials,
    enablement,
    flows,
    vault,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // OAuth requests refuse private hosts by default; local MCP servers are a dev opt-in
    oauth: { allowPrivateNetwork: env.TEAM_ALLOW_PRIVATE_MCP === '1' },
    redirectUri: options.redirectUri,
    clientConfig: async (id, flow) => {
      // a custom connector's own OAuth client lives in the settings of that connection
      if (id === CUSTOM_DEFINITION) {
        const clientId = flow.settings.oauthClientId
        if (typeof clientId !== 'string' || clientId === '') return undefined
        const secret = flow.settings.oauthClientSecret
        return {
          clientId,
          ...(typeof secret === 'string' && secret !== '' ? { clientSecret: secret } : {}),
        }
      }
      if (id === TELEGRAM_USER_CONNECTOR_ID) {
        const app = await telegramApp()
        return app === undefined ? undefined : { apiId: app.apiId, apiHash: app.apiHash }
      }
      return (await clientSource(id))?.value
    },
    lock: sqliteRefreshLock(options.lock),
  })

  const isBuiltin = (id: string): boolean => defs.get(id)?.source === 'builtin'
  const definitionOf = (id: string): AnyConnectorDefinition => {
    const d = defs.get(id)
    if (d === undefined) throw notFound('connector', id)
    return d
  }
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      return mapConfigError(error, {
        noun: 'connection',
        idKey: 'id',
        notFoundReasons: ['not-found'],
      })
    }
  }

  // --- views -------------------------------------------------------------------------------

  const capView = (c: {
    id: string
    title: string
    description: string
    kind: CapabilityKind | 'external'
    tools: string[]
    defaultMode: CapabilityMode
  }) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    kind: c.kind,
    tools: [...c.tools],
    defaultMode: c.defaultMode,
  })

  async function catalogEntry(d: AnyConnectorDefinition): Promise<ConnectorView> {
    const desc = describeConnector(d)
    const needsClient = d.auth.type === 'oauth2' && d.auth.client !== undefined
    const view: ConnectorView = {
      id: d.id,
      name: d.name,
      description: d.description,
      ...(d.icon === undefined ? {} : { icon: d.icon }),
      ...(d.publisher === undefined ? {} : { publisher: d.publisher }),
      ...(d.homepage === undefined ? {} : { homepage: d.homepage }),
      ...(d.docsUrl === undefined ? {} : { docsUrl: d.docsUrl }),
      category: d.category,
      source: d.source,
      scopes: [...d.scopes],
      auth: {
        type: desc.auth.type,
        ...(desc.auth.scopes === undefined ? {} : { scopes: desc.auth.scopes }),
      },
      fields: desc.form.fields as ConnectorView['fields'],
      capabilities: d.capabilities.map(capView),
      builtin: d.source === 'builtin',
      leadOnly: d.id === 'team',
    }
    if (needsClient) {
      const found = await clientSource(d.id)
      view.oauthClient = {
        required: true,
        configured: found !== undefined,
        source: found?.source ?? null,
        redirectUri: options.redirectUri,
        envVars: [envName(d.id, 'CLIENT_ID'), envName(d.id, 'CLIENT_SECRET')],
      }
    }
    return view
  }

  const toConnection = (p: Awaited<ReturnType<typeof service.get>> & object): ConnectionView => ({
    id: p.id,
    definitionId: p.definitionId,
    label: p.label,
    enabled: p.enabled,
    scope: p.scope,
    ...(p.scopeId === undefined ? {} : { scopeId: p.scopeId }),
    status: p.status,
    ...(p.statusMessage === undefined ? {} : { statusMessage: p.statusMessage }),
    ...(p.accountLabel === undefined ? {} : { accountLabel: p.accountLabel }),
    defaultEnabled: p.defaultEnabled,
    ...(p.defaultModes === undefined ? {} : { defaultModes: p.defaultModes }),
    ...(p.capabilities === undefined ? {} : { capabilities: p.capabilities.map(capView) }),
    settings: p.settings,
    authorized: p.authorized,
    builtin: isBuiltin(p.definitionId),
    custom: defs.get(p.definitionId)?.source === 'custom',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  })

  const toFlow = (r: Awaited<ReturnType<typeof service.startConnect>>): FlowResult => ({
    flow: r.flow as unknown as FlowDto,
    ...(r.connection === undefined ? {} : { connection: toConnection(r.connection) }),
  })

  // --- access: who uses a connection ---------------------------------------------------------

  /** Enablement of every (non-archived) agent, read once per listing. */
  async function enablementOfAll(): Promise<Map<string, AgentEnablement>> {
    const out = new Map<string, AgentEnablement>()
    for (const a of options.agents()) out.set(a.id, await enablement.get(a.id))
    return out
  }

  function connectionAccess(
    r: Pick<ConnectionRecord, 'id' | 'scope' | 'scopeId' | 'defaultEnabled'>,
    all: Map<string, AgentEnablement>,
  ): ConnectionAccess {
    if (r.scope === 'agent') {
      return {
        mode: 'selected',
        agentIds:
          r.scopeId !== undefined &&
          all.has(r.scopeId) &&
          all.get(r.scopeId)?.[r.id]?.enabled !== 'off'
            ? [r.scopeId]
            : [],
        excludedAgentIds: [],
      }
    }
    const ids = [...all.keys()]
    const state = (id: string) => all.get(id)?.[r.id]?.enabled ?? 'inherit'
    if (r.defaultEnabled) {
      const excluded = ids.filter((id) => state(id) === 'off')
      return {
        mode: 'all',
        agentIds: ids.filter((id) => state(id) !== 'off'),
        excludedAgentIds: excluded,
      }
    }
    return {
      mode: 'selected',
      agentIds: ids.filter((id) => state(id) === 'on'),
      excludedAgentIds: [],
    }
  }

  const withAccess = async (
    views: ConnectionView[],
    all?: Map<string, AgentEnablement>,
  ): Promise<ConnectionView[]> => {
    const map = all ?? (await enablementOfAll())
    return views.map((v) => (v.builtin ? v : { ...v, access: connectionAccess(v, map) }))
  }

  /** Keep what the agent chose for capabilities and tools; only the on/off switch changes. */
  async function setState(agentId: string, connectionId: string, state: 'on' | 'inherit') {
    const current = (await enablement.get(agentId))[connectionId]
    if (state === 'on') {
      if (current?.enabled === 'on') return
      await enablement.set(agentId, connectionId, { ...(current ?? {}), enabled: 'on' })
      return
    }
    if (current === undefined || (current.enabled ?? 'inherit') === 'inherit') return
    const { enabled: _drop, ...rest } = current
    await enablement.set(agentId, connectionId, Object.keys(rest).length === 0 ? undefined : rest)
  }

  async function setAccess(id: string, input: ConnectionAccessInput): Promise<ConnectionView> {
    const record = await connections.get(id)
    if (record === undefined) throw notFound('connection', id)
    const d = definitionOf(record.definitionId)
    if (d.source === 'builtin') {
      throw conflict('built-in connections are included; turn them on per agent', 'BUILTIN')
    }
    if (!d.scopes.includes('workspace')) {
      throw invalid(`${d.name} can not be shared between agents`)
    }
    const known = new Set(options.agents().map((a) => a.id))
    const check = (ids: readonly string[] | undefined): string[] => {
      for (const a of ids ?? []) if (!known.has(a)) throw invalid(`unknown agent: ${a}`)
      return [...new Set(ids ?? [])]
    }
    const all = await enablementOfAll()
    if (input.mode === 'selected') {
      const chosen = new Set(check(input.agentIds))
      // an agent-scoped connection keeps its agent unless the caller drops it explicitly
      for (const a of known) {
        const state = all.get(a)?.[id]?.enabled ?? 'inherit'
        if (chosen.has(a)) await setState(a, id, 'on')
        else if (state !== 'inherit') await setState(a, id, 'inherit')
      }
    } else {
      const wasAll = record.scope === 'workspace' && record.defaultEnabled
      const excluded = new Set(
        input.excludedAgentIds !== undefined
          ? check(input.excludedAgentIds)
          : wasAll
            ? [...known].filter((a) => all.get(a)?.[id]?.enabled === 'off')
            : [],
      )
      for (const a of known) {
        const state = all.get(a)?.[id]?.enabled ?? 'inherit'
        if (excluded.has(a)) {
          if (state !== 'off') {
            const cur = all.get(a)?.[id]
            await enablement.set(a, id, { ...(cur ?? {}), enabled: 'off' })
          }
        } else if (state !== 'inherit') await setState(a, id, 'inherit')
      }
    }
    // the connection last (id, credentials, slug and settings stay as they are)
    const next: ConnectionRecord = { ...record, defaultEnabled: input.mode === 'all' }
    if (record.scope === 'agent') {
      next.scope = 'workspace'
      delete next.scopeId
    }
    if (next.scope !== record.scope || next.defaultEnabled !== record.defaultEnabled) {
      next.updatedAt = Date.now()
      await connections.put(next)
    } else {
      changed()
    }
    const saved = (await service.get(id)) as NonNullable<Awaited<ReturnType<typeof service.get>>>
    return (await withAccess([toConnection(saved)]))[0] as ConnectionView
  }

  // --- activation --------------------------------------------------------------------------

  const cache = new Map<
    string,
    {
      key: string
      out: ActivatedConnectors
      kinds: Record<string, CapabilityKind>
      readAllowed: ReadonlySet<string>
    }
  >()
  const ensured = new Set<string>()
  let busy: Promise<void> = Promise.resolve()
  const accessOf = (d: AgentDef): ToolAccess => d.toolAccess ?? options.toolAccess?.() ?? 'auto'
  const keyOf = (d: AgentDef): string => `${d.version}@${revision}@${accessOf(d)}`

  async function ensureBuiltins(list: readonly AgentDef[]): Promise<void> {
    const todo = list.filter((a) => !ensured.has(a.id))
    if (!ensured.has('')) {
      await ensureBuiltinConnections({ store: connections, definitions })
      ensured.add('')
    }
    for (const a of todo) {
      await ensureBuiltinConnections({ store: connections, definitions, agentId: a.id })
      ensured.add(a.id)
    }
  }

  /**
   * `on-demand`: the tools of third-party connectors are found with `tool_search`. `auto`: they
   * load up front until the agent has {@link TOOL_ACCESS_AUTO_THRESHOLD} or more (counted from the
   * capabilities the connections declare), then they are deferred; below it a server that lists
   * more tools than the MCP threshold still defers by itself.
   */
  async function deferOf(d: AgentDef): Promise<boolean | 'auto'> {
    if (accessOf(d) === 'on-demand') return true
    const views = await agentView(d)
    let n = 0
    for (const v of views) {
      if (v.source === 'builtin' || !v.enabled) continue
      for (const c of v.capabilities) n += c.toolModes.filter((t) => t.mode !== 'off').length
    }
    return n >= TOOL_ACCESS_AUTO_THRESHOLD ? true : 'auto'
  }

  async function doPrepare(list: readonly AgentDef[]): Promise<void> {
    await ensureBuiltins(list)
    const need = list.filter((d) => cache.get(d.id)?.key !== keyOf(d))
    if (need.length === 0) return
    const key = (d: AgentDef): string => keyOf(d)
    const records = await connections.list()
    for (const d of need) {
      deferNow = await deferOf(d)
      const out = await activateConnectors({
        definitions,
        connections: records,
        enablement: await enablement.get(d.id),
        agent: { id: d.id },
        accessToken: (id) => service.accessToken(id),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        // bounded connect/list (EH_MCP_TIMEOUT): a dead server costs one timeout, not a hung turn
        mcp: (spec) => remoteMcpSource({ ...spec, timeoutMs: MCP_TIMEOUT_MS }),
        // the app's own rules merge with the connector rules (most restrictive wins)
        appRules: appRulesOf(d),
      })
      for (const w of out.warnings) {
        // a connection that still needs sign in is a normal state the UI shows, not a server problem
        if (w.code !== 'connection-unavailable') warn(`connectors (${d.slug}): ${w.message}`)
      }
      const kinds: Record<string, CapabilityKind> = {}
      const readAllowed = new Set<string>()
      for (const [tool, origin] of Object.entries(out.toolNameMap)) {
        const record = records.find((r) => origin.connectionIds.includes(r.id))
        const def = defs.get(origin.connectorId)
        if (record === undefined || def === undefined) continue
        const capability = capabilitiesOf(def, record).find((c) => c.id === origin.capabilityId)
        if (capability !== undefined) kinds[tool] = capability.kind
        // A built-in READ capability shown as "Allowed" runs without asking in Manual mode (D13 of
        // the e2e pass: a researcher whose web tools are Allowed was asked for every search).
        // The library leaves built-ins to the chat's permission mode, and Auto and Bypass keep
        // their own handling (the classifier still looks at the call in Auto).
        const mode = out.connections.find((c) => origin.connectionIds.includes(c.connectionId))
          ?.modes[origin.capabilityId]
        if (
          def.source === 'builtin' &&
          (capability?.kind === 'read' || capability?.kind === 'external') &&
          mode === 'allow' &&
          !out.rules.deny.includes(tool) &&
          !out.rules.ask.includes(tool)
        ) {
          readAllowed.add(tool)
        }
      }
      cache.set(d.id, { key: key(d), out, kinds, readAllowed })
    }
  }

  const prepare = (list: readonly AgentDef[]): Promise<void> => {
    const run = busy.then(() => doPrepare(list))
    busy = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // --- reachability -------------------------------------------------------------------------

  /**
   * A custom server that went down used to show "Connected" until somebody pressed Test (D18 of
   * the e2e pass). Listing the connections starts a background check of each remote server whose
   * last check is older than `TEAM_CONNECTOR_HEALTH_TTL_MS` (default 60 s, 0 = every listing, a negative value turns it off): one tool listing, never awaited, never twice at once.
   * The result lands in the connection row (status and message), so the next listing and the
   * connectors-changed event carry it. Built-in and other flows with their own runtimes are left
   * alone.
   */
  const ttlSetting = Number(env.TEAM_CONNECTOR_HEALTH_TTL_MS ?? 60_000)
  const HEALTH_TTL_MS = Number.isFinite(ttlSetting) ? ttlSetting : 60_000
  const checkedAt = new Map<string, number>()
  const probing = new Set<string>()
  let closing = false
  function refreshHealth(
    list: ReadonlyArray<{ id: string; definitionId: string; status: string }>,
  ): void {
    if (HEALTH_TTL_MS < 0) return
    const now = Date.now()
    for (const c of list) {
      if (defs.get(c.definitionId)?.source !== 'custom') continue
      if (c.status !== 'connected' && c.status !== 'error') continue
      if (probing.has(c.id) || now - (checkedAt.get(c.id) ?? 0) < HEALTH_TTL_MS) continue
      checkedAt.set(c.id, now)
      probing.add(c.id)
      void (async () => {
        try {
          const before = c.status
          const result = await service.test(c.id)
          if (closing) return
          const after = await service.get(c.id)
          if (after !== undefined && after.status !== before) changed()
          if (!result.ok && before === 'connected')
            warn(`connectors: ${c.id} is not reachable: ${result.message ?? 'no answer'}`)
        } catch {
          // the next listing tries again after the TTL
        } finally {
          probing.delete(c.id)
        }
      })()
    }
  }

  // --- the agent's view ----------------------------------------------------------------------

  async function agentView(agent: AgentDef): Promise<AgentConnectorView[]> {
    await ensureBuiltins([agent])
    const records = await connections.list()
    const entries: AgentEnablement = await enablement.get(agent.id)
    const out: AgentConnectorView[] = []
    for (const r of records) {
      const d = defs.get(r.definitionId)
      if (d === undefined || !d.scopes.includes(r.scope)) continue
      if (r.scope === 'agent' && r.scopeId !== agent.id) continue
      if (r.scope === 'user') continue
      if (d.id === 'team' && agent.role !== 'lead') continue
      const e = entries[r.id]
      const caps = capabilitiesOf(d, r)
      const resolved = resolveModes(caps, r, e)
      const finalNames = cache.get(agent.id)?.out.toolNameMap
      out.push({
        connectionId: r.id,
        connectorId: d.id,
        // a custom connector is shown under the name its user gave it
        name: d.source === 'custom' ? r.label : d.name,
        ...(d.icon === undefined ? {} : { icon: d.icon }),
        category: d.category,
        source: d.source,
        label: r.label,
        ...(r.accountLabel === undefined ? {} : { accountLabel: r.accountLabel }),
        status: r.status,
        ...(r.statusMessage === undefined ? {} : { statusMessage: r.statusMessage }),
        scope: r.scope as 'workspace' | 'agent',
        ownership: r.scope === 'agent' ? 'agent' : 'workspace',
        defaultEnabled: r.defaultEnabled,
        state: e?.enabled ?? 'inherit',
        enabled: isConnectionEnabled(r, e, { agentId: agent.id }),
        capabilities: caps.map((c) => ({
          ...capView(c),
          mode: resolved.modes[c.id] ?? c.defaultMode,
          inherited: r.defaultModes?.[c.id] ?? c.defaultMode,
          ...(e?.capabilities?.[c.id] === undefined ? {} : { override: e.capabilities[c.id] }),
          pinned: d.source !== 'builtin' && (c.kind === 'write' || c.kind === 'destructive'),
          toolModes: c.tools.map((t) => ({
            name: t,
            mode: resolved.toolModes[t] ?? c.defaultMode,
            ...(e?.tools?.[t] === undefined ? {} : { override: e.tools[t] }),
          })),
          // the names the agent really calls these tools by (prefixed per connection)
          ...(finalNames === undefined
            ? {}
            : {
                agentTools: Object.entries(finalNames)
                  .filter(([, o]) => o.capabilityId === c.id && o.connectionIds.includes(r.id))
                  .map(([name]) => name),
              }),
        })) as AgentConnectorView['capabilities'],
      })
    }
    // built-ins first (the prompt order), then by connector and label
    const rank = (v: AgentConnectorView): number => (v.source === 'builtin' ? 0 : 1)
    return out.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.connectorId.localeCompare(b.connectorId) ||
        a.label.localeCompare(b.label),
    )
  }

  // another instance changed a connection or an enablement: agents rebuild from the new revision
  options.changes?.on('connectors-changed', () => {
    revision++
  })

  // --- the port ------------------------------------------------------------------------------

  const checkStart = async (input: Parameters<ConnectorsPort['startFlow']>[0]) => {
    if (input.connectionId !== undefined) return
    if (input.definitionId === undefined) throw invalid('definitionId or connectionId is required')
    const d = definitionOf(input.definitionId)
    if (d.source === 'builtin')
      throw conflict(`${d.name} is included: there is nothing to connect`, 'BUILTIN')
    const scope = input.scope ?? 'workspace'
    if (!d.scopes.includes(scope)) throw invalid(`${d.name} can not be connected at ${scope} scope`)
    if (scope === 'agent') {
      if (input.scopeId === undefined || options.agentById(input.scopeId) === undefined) {
        throw invalid('scopeId must be the id of an agent for agent scope')
      }
    } else if (input.scopeId !== undefined) {
      throw invalid('workspace scope has no scopeId')
    }
  }

  // --- custom connectors -------------------------------------------------------------------

  /** Slugs in use: stored ones, the slug the library derives for the others, connector ids. */
  async function takenSlugs(): Promise<Set<string>> {
    const taken = new Set<string>(definitions.map((d) => d.id))
    for (const r of await connections.list()) {
      taken.add(r.slug ?? (slugOf(r.label) || slugOf(r.id)))
    }
    return taken
  }

  /** A custom connection made by the generic flow gets its stable slug the first time it is seen. */
  async function ensureSlug(connection: { id: string; definitionId: string } | undefined) {
    if (connection === undefined || connection.definitionId !== CUSTOM_DEFINITION) return
    const record = await connections.get(connection.id)
    if (record === undefined || record.slug !== undefined) return
    const taken = await takenSlugs()
    taken.delete(slugOf(record.label) || slugOf(record.id))
    await connections.put({ ...record, slug: uniqueSlug(record.label, taken) })
  }

  const fetcher = (): typeof fetch => options.fetch ?? globalThis.fetch
  const listTools = options.listTools ?? listRemoteMcpTools

  /**
   * SSRF guard: a custom connector URL must not point at a private, loopback or link-local host
   * (literal or resolved), unless `TEAM_ALLOW_PRIVATE_MCP=1` (local MCP servers, dev only).
   */
  async function assertPublicEndpoint(url: string): Promise<void> {
    if (env.TEAM_ALLOW_PRIVATE_MCP === '1') return
    const host = new URL(url).hostname
    const refuse = (): never => {
      throw invalid(
        'url points at a private or local host; set TEAM_ALLOW_PRIVATE_MCP=1 on the server to allow it',
      )
    }
    if (isPrivateHost(host)) refuse()
    // names that resolve to private ranges; skipped when a test injected its own fetch
    const resolve = options.resolveHost ?? (options.fetch === undefined ? lookupAll : undefined)
    if (resolve === undefined) return
    let addresses: string[] = []
    try {
      addresses = await resolve(host)
    } catch {
      // unresolvable: the probe reports it
    }
    if (addresses.some((a) => isPrivateHost(a))) refuse()
  }

  /**
   * The fetch of the probe: every request URL is checked again (a hostname is resolved right
   * before it is fetched, so a name that flipped to a private address since the form was checked is
   * refused) and redirects are never followed (a 3xx to an internal host is returned as is).
   *
   * Residual risk, documented on purpose: this is check-then-connect. A DNS server that answers a
   * public address to the check and a private one to the connection (DNS rebinding, a few
   * milliseconds apart) can still win the race, and the stored connector is fetched again later by
   * the library at runtime. Bun's `fetch` cannot pin a resolved IP without breaking TLS (SNI and
   * certificate checks need the host name). Close the gap at the network: run the server with an
   * egress policy that blocks private ranges and the metadata address, or send MCP traffic through
   * a DNS-pinning proxy.
   */
  const guardedProbeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    await assertPublicEndpoint(url)
    return fetcher()(input, { ...init, redirect: 'manual' })
  }) as typeof fetch

  async function probeCustom(input: { url: string }): Promise<CustomProbe> {
    if (!isAllowedMcpUrl(input.url)) {
      throw invalid('url must be an https URL (http only on localhost)')
    }
    await assertPublicEndpoint(input.url)
    let res: Response
    try {
      res = await guardedProbeFetch(input.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'eharness-team', version: '1' },
          },
        }),
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      return { detected: 'unknown', message: 'Could not reach the server. Check the URL.' }
    }
    if (res.status === 401) {
      void res.body?.cancel().catch(() => undefined)
      try {
        const found = await discoverMcpAuthorization(input.url, {
          fetch: guardedProbeFetch,
          allowPrivateNetwork: env.TEAM_ALLOW_PRIVATE_MCP === '1',
        })
        return {
          detected: 'oauth',
          message: 'This server asks you to sign in.',
          oauth: {
            discovered: true,
            issuer: found.server.issuer,
            dynamicRegistration: found.server.registration_endpoint !== undefined,
          },
        }
      } catch {
        return {
          detected: 'oauth',
          message: 'This server asks you to sign in, but did not say how.',
          oauth: { discovered: false, dynamicRegistration: false },
        }
      }
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      return {
        detected: 'unknown',
        message: `The server answered HTTP ${res.status}. It may need request headers.`,
      }
    }
    let serverName: string | undefined
    try {
      const text = await res.text()
      const line = text.startsWith('{')
        ? text
        : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5)
      const info = (
        JSON.parse(line) as { result?: { serverInfo?: { name?: unknown; title?: unknown } } }
      ).result?.serverInfo
      const n = info?.title ?? info?.name
      if (typeof n === 'string' && n !== '') serverName = n.slice(0, 80)
    } catch {
      // not JSON: the server still answered
    }
    let tools: number | undefined
    try {
      tools = (await listTools({ url: input.url })).length
    } catch {
      // listing is optional here
    }
    return {
      detected: 'none',
      message: 'No sign in needed.',
      ...(serverName === undefined ? {} : { serverName }),
      ...(tools === undefined ? {} : { tools }),
    }
  }

  async function createCustom(input: CustomConnectorInput): Promise<CustomConnectorResult> {
    await assertPublicEndpoint(input.url)
    const taken = await takenSlugs()
    const id = `conn_${crypto.randomUUID()}`
    const now = Date.now()
    const oauth = input.signIn !== 'none'
    const scope = input.scope ?? 'workspace'
    const record: ConnectionRecord = {
      id,
      kind: 'connection',
      definitionId: CUSTOM_DEFINITION,
      label: input.name,
      slug: uniqueSlug(input.name, taken),
      settings: {
        url: input.url,
        authMode: oauth ? 'oauth' : input.headers === undefined ? 'none' : 'headers',
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        transport: 'http',
        ...(oauth && input.oauthClient !== undefined
          ? {
              oauthClientId: input.oauthClient.clientId,
              ...(input.oauthClient.clientSecret === undefined
                ? {}
                : { oauthClientSecret: input.oauthClient.clientSecret }),
            }
          : {}),
      },
      enabled: true,
      scope,
      ...(scope === 'agent' && input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
      status: oauth ? 'needs-auth' : 'connected',
      ...(oauth ? { statusMessage: 'Sign in to use it.' } : {}),
      defaultEnabled: scope === 'agent' ? true : (input.availableToAll ?? false),
      createdAt: now,
      updatedAt: now,
    }
    await connections.put(record)
    if (!oauth) {
      // nothing to sign in to: connect now, so the tools are discovered (a bad URL saves nothing)
      const result = await service.test(id)
      if (!result.ok) {
        await service.remove(id)
        throw invalid(result.message ?? 'Could not connect to the server.', 'CONNECT_FAILED')
      }
    }
    if (scope === 'workspace' && !record.defaultEnabled) {
      for (const agentId of input.agentIds ?? []) await setState(agentId, id, 'on')
    }
    const saved = (await service.get(id)) as NonNullable<Awaited<ReturnType<typeof service.get>>>
    const view = (await withAccess([toConnection(saved)]))[0] as ConnectionView
    if (input.signIn === 'now') {
      const started = await service.reconnect(id)
      return { connection: view, flow: started.flow as unknown as FlowDto }
    }
    return { connection: view }
  }

  return {
    hooks,
    definitions,
    rev: () => revision,
    prepare,
    accessTokenFor: (connectionId) => service.accessToken(connectionId),
    markNeedsAuth: (connectionId, message) => service.markNeedsAuth(connectionId, message),
    credentialsOf: (connectionId) => service.credentials(connectionId),
    telegramApp,
    activated: (agentId) => cache.get(agentId)?.out,
    toolKinds: (agentId) => cache.get(agentId)?.kinds,
    readAllowed: (agentId) => cache.get(agentId)?.readAllowed,
    profileChanged: (kind) => {
      if (kind === 'connection') changed()
    },
    ensureBuiltins,
    stores: { connections },
    close() {
      closing = true
    },

    catalog: () => Promise.all(definitions.map(catalogEntry)),
    connections: async (query) => {
      const listed = await service.list({
        ...(query?.scope === undefined ? {} : { scope: query.scope }),
        ...(query?.scopeId === undefined ? {} : { scopeId: query.scopeId }),
      })
      refreshHealth(listed)
      return withAccess(listed.map(toConnection))
    },
    setAccess: (id, input) => wrap(() => setAccess(id, input)),
    startFlow: async (input) =>
      wrap(async () => {
        await checkStart(input)
        void service.sweep()
        if (input.connectionId !== undefined) {
          const current = await service.get(input.connectionId)
          return toFlow(
            await service.reconnect(input.connectionId, principalOf(current?.definitionId)),
          )
        }
        return toFlow(
          await service.startConnect({
            ...principalOf(input.definitionId),
            definitionId: input.definitionId as string,
            scope: input.scope ?? 'workspace',
            ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.defaultEnabled === undefined ? {} : { defaultEnabled: input.defaultEnabled }),
          }),
        )
      }),
    getFlow: async (id) => {
      const r = await service.getFlow(id)
      return r === undefined ? undefined : toFlow(r)
    },
    act: async (id, input) =>
      wrap(async () => {
        const flowState = await service.getFlow(id)
        const r = await service.advance(id, {
          ...principalOf(flowState?.flow.definitionId),
          viewId: input.viewId,
          action: input.action,
          ...(input.data === undefined ? {} : { data: input.data }),
        })
        const flow = r.flow === undefined ? {} : { flow: r.flow as unknown as FlowDto }
        await ensureSlug(r.connection)
        const connection =
          r.connection === undefined ? {} : { connection: toConnection(r.connection) }
        if (r.ok) return { ok: true as const, ...(flow as { flow: FlowDto }), ...connection }
        return { ok: false as const, error: r.error, message: r.message, ...flow, ...connection }
      }),
    oauthCallback: async (query) => {
      // `/oauth/callback` is a browser redirect without the bearer token, so the example cannot
      // bind the flow to a person. An app with browser sessions passes `principal` here and to
      // `startConnect` / `reconnect` / `act` (the `principal` option), so a callback delivered in
      // another person's browser fails with `principal-mismatch` (login CSRF).
      const r = await wrap(() =>
        service.completeOAuth({
          state: query.state ?? '',
          ...(query.code === undefined ? {} : { code: query.code }),
          ...(query.error === undefined ? {} : { error: query.error }),
          ...(query.errorDescription === undefined
            ? {}
            : { errorDescription: query.errorDescription }),
        }),
      )
      await ensureSlug(r.ok ? r.connection : undefined)
      if (r.flow !== undefined) return { flowId: r.flow.id }
      return { error: r.ok ? 'unknown' : r.message }
    },
    updateConnection: async (id, patch) =>
      wrap(async () => {
        const current = await service.get(id)
        if (current === undefined) throw notFound('connection', id)
        const d = definitionOf(current.definitionId)
        if (d.source === 'builtin' && (patch.settings !== undefined || patch.scope !== undefined)) {
          throw conflict('built-in connections have no settings and keep their scope', 'BUILTIN')
        }
        await service.update(id, {
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.defaultEnabled === undefined ? {} : { defaultEnabled: patch.defaultEnabled }),
          ...(patch.defaultModes === undefined ? {} : { defaultModes: patch.defaultModes }),
          ...(patch.settings === undefined ? {} : { settings: patch.settings }),
        })
        if (patch.scope !== undefined && patch.scope !== current.scope) {
          if (!d.scopes.includes(patch.scope))
            throw invalid(`${d.name} can not be connected at ${patch.scope} scope`)
          const record = (await connections.get(id)) as ConnectionRecord
          if (patch.scope === 'agent') {
            if (patch.scopeId === undefined || options.agentById(patch.scopeId) === undefined) {
              throw invalid('scopeId must be the id of an agent for agent scope')
            }
            record.scope = 'agent'
            record.scopeId = patch.scopeId
          } else {
            record.scope = 'workspace'
            delete record.scopeId
          }
          record.updatedAt = Date.now()
          await connections.put(record)
        }
        return (
          await withAccess([
            toConnection(
              (await service.get(id)) as NonNullable<Awaited<ReturnType<typeof service.get>>>,
            ),
          ])
        )[0] as ConnectionView
      }),
    removeConnection: async (id) =>
      wrap(async () => {
        const current = await service.get(id)
        if (current === undefined) throw notFound('connection', id)
        if (isBuiltin(current.definitionId)) {
          throw conflict('built-in connections are included and can not be removed', 'BUILTIN')
        }
        await service.remove(id)
      }),
    testConnection: async (id) =>
      wrap(async () => {
        if ((await service.get(id)) === undefined) throw notFound('connection', id)
        const result = await service.test(id)
        const record = (await service.get(id)) as NonNullable<
          Awaited<ReturnType<typeof service.get>>
        >
        return {
          ok: result.ok,
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.accountLabel === undefined ? {} : { accountLabel: result.accountLabel }),
          ...(result.capabilities === undefined
            ? {}
            : { tools: result.capabilities.reduce((n, c) => n + c.tools.length, 0) }),
          connection: (await withAccess([toConnection(record)]))[0] as ConnectionView,
        }
      }),
    probeCustom,
    createCustom: (input) => wrap(() => createCustom(input)),
    agentConnectors: async (agent) => {
      // prepared first so the view can name the tools as the agent calls them
      await prepare([agent]).catch(() => undefined)
      return agentView(agent)
    },
    setAgentConnectors: async (agent, changes) => {
      const known = new Set((await agentView(agent)).map((v) => v.connectionId))
      for (const id of Object.keys(changes)) {
        if (!known.has(id)) throw notFound('connection', id)
      }
      for (const [id, value] of Object.entries(changes)) {
        await enablement.set(
          agent.id,
          id,
          value === null ? undefined : (value as ConnectionChoices),
        )
      }
      return agentView(agent)
    },
    setOAuthClient: async (definitionId, input) => {
      const d = definitionOf(definitionId)
      if (!(d.auth.type === 'oauth2' && d.auth.client !== undefined)) {
        throw invalid(`${d.name} does not use OAuth app credentials`)
      }
      if (input.clientId.trim() === '') throw invalid('clientId must not be empty')
      await sealed.put({
        id: definitionId,
        kind: CLIENT_KIND,
        definitionId,
        label: d.name,
        settings: {
          clientId: input.clientId.trim(),
          ...(input.clientSecret === undefined || input.clientSecret === ''
            ? {}
            : { clientSecret: input.clientSecret }),
        },
        enabled: true,
        updatedAt: Date.now(),
      })
    },
    removeOAuthClient: async (definitionId) => {
      definitionOf(definitionId)
      await sealed.delete(CLIENT_KIND, definitionId)
    },
  }
}
