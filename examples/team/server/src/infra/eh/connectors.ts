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
import type { SessionLock } from 'eharness'
import {
  type ActivatedConnectors,
  type AgentEnablement,
  type AnyConnectorDefinition,
  activateConnectors,
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
  /** The OAuth callback URL of this server. */
  redirectUri: string
  events?: { append(event: NewEvent): number }
  /** Workspace default tool access (settings); default `auto`. Read on every `prepare`. */
  toolAccess?: () => ToolAccess
  /** Other instances' changes (`connectors-changed`) bump the revision. */
  changes?: ChangeFeed
  /** Id of this instance (its own events are ignored). */
  instance: string
  warn?: (message: string) => void
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
  /** The last activation of an agent, or undefined when it was never prepared. */
  activated(agentId: string): ActivatedConnectors | undefined
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

const envName = (definitionId: string, suffix: string): string =>
  `TEAM_${definitionId.toUpperCase().replaceAll('-', '_')}_${suffix}`

export function createConnectors(options: ConnectorsOptions): ConnectorsRuntime {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const hooks: CatalogHooks = {}
  // `defer` of the remote MCP servers of the agent `doPrepare` is activating (activation is serialized)
  let deferNow: boolean | 'auto' = true
  const definitions = createConnectorDefinitions({
    defer: () => deferNow,
    sqlite: options.sqlite,
    agentById: options.agentById,
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.listTools === undefined ? {} : { listTools: options.listTools }),
    ...(options.onFileChange === undefined ? {} : { onFileChange: options.onFileChange }),
    hooks,
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

  const service = createConnectorService({
    definitions,
    connections,
    credentials,
    enablement,
    flows,
    vault,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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
    kind: 'read' | 'write' | 'destructive' | 'external'
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

  // --- activation --------------------------------------------------------------------------

  const cache = new Map<string, { key: string; out: ActivatedConnectors }>()
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
        mcp: remoteMcpSource,
        // the app's own rules merge with the connector rules (most restrictive wins)
        appRules: appRulesOf(d),
      })
      for (const w of out.warnings) {
        // a connection that still needs sign in is a normal state the UI shows, not a server problem
        if (w.code !== 'connection-unavailable') warn(`connectors (${d.slug}): ${w.message}`)
      }
      cache.set(d.id, { key: key(d), out })
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

  async function probeCustom(input: { url: string }): Promise<CustomProbe> {
    if (!isAllowedMcpUrl(input.url)) {
      throw invalid('url must be an https URL (http only on localhost)')
    }
    let res: Response
    try {
      res = await fetcher()(input.url, {
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
        const found = await discoverMcpAuthorization(input.url, { fetch: fetcher() })
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
    const saved = (await service.get(id)) as NonNullable<Awaited<ReturnType<typeof service.get>>>
    if (input.signIn === 'now') {
      const started = await service.reconnect(id)
      return { connection: toConnection(saved), flow: started.flow as unknown as FlowDto }
    }
    return { connection: toConnection(saved) }
  }

  return {
    hooks,
    definitions,
    rev: () => revision,
    prepare,
    accessTokenFor: (connectionId) => service.accessToken(connectionId),
    activated: (agentId) => cache.get(agentId)?.out,
    profileChanged: (kind) => {
      if (kind === 'connection') changed()
    },
    ensureBuiltins,
    stores: { connections },
    close() {},

    catalog: () => Promise.all(definitions.map(catalogEntry)),
    connections: async (query) =>
      (
        await service.list({
          ...(query?.scope === undefined ? {} : { scope: query.scope }),
          ...(query?.scopeId === undefined ? {} : { scopeId: query.scopeId }),
        })
      ).map(toConnection),
    startFlow: async (input) =>
      wrap(async () => {
        await checkStart(input)
        void service.sweep()
        if (input.connectionId !== undefined)
          return toFlow(await service.reconnect(input.connectionId))
        return toFlow(
          await service.startConnect({
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
        const r = await service.advance(id, {
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
        return toConnection(
          (await service.get(id)) as NonNullable<Awaited<ReturnType<typeof service.get>>>,
        )
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
          connection: toConnection(record),
        }
      }),
    probeCustom,
    createCustom: (input) => wrap(() => createCustom(input)),
    agentConnectors: (agent) => agentView(agent),
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
