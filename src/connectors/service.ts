/**
 * `createConnectorService`: the stores, the flow engine and the credential manager behind one
 * object an application's routes call. Everything it returns is safe for a browser: connections
 * are redacted, flows carry no scratch, tokens are never returned.
 *
 * @see docs/specs/24-connectors.md#10-the-connector-service
 */
import { mergeSecretPatch, validateSettings } from '../providers/index.ts'
import { type ActivateOptions, activateConnectors } from './activate.ts'
import { createCredentialManager, type RefreshLock } from './credentials.ts'
import {
  type ConnectorDescription,
  connectorSchema,
  describeConnector,
  publicConnection,
} from './definition.ts'
import {
  advanceFlow,
  completeOAuth,
  flowCompletion,
  type OAuthCallback,
  publicFlow,
  resolveFlowDeps,
  startFlow,
} from './flow.ts'
import type {
  ActivatedConnectors,
  AgentEnablement,
  AnyConnectorDefinition,
  CapabilityMode,
  ConnectionEnablement,
  ConnectionRecord,
  ConnectionStore,
  ConnectorScope,
  ConnectorTestResult,
  CredentialStore,
  EnablementStore,
  FlowDeps,
  FlowInput,
  FlowState,
  FlowStore,
  PublicConnection,
  PublicFlow,
  SecretVault,
} from './types.ts'
import { connectorError } from './util.ts'

/** Options of {@link createConnectorService}. */
export interface ConnectorServiceOptions {
  definitions: readonly AnyConnectorDefinition[]
  connections: ConnectionStore
  credentials: CredentialStore
  enablement: EnablementStore
  flows: FlowStore
  vault: SecretVault
  fetch?: typeof fetch
  now?: () => number
  newId?: () => string
  /** OAuth redirect URI of the app's callback route (or one per connector). */
  redirectUri?: FlowDeps['redirectUri']
  /** Admin OAuth client configuration of a connector. */
  clientConfig?: FlowDeps['clientConfig']
  /** Lock for token refreshes; use a distributed one with several instances. */
  lock?: RefreshLock
  /** Flow lifetime. Default 15 minutes. */
  ttlMs?: number
}

/** A flow for a browser, with the connection once the flow finished. */
export interface ServiceFlow {
  flow: PublicFlow
  /** Set when the flow finished and the connection was saved. */
  connection?: PublicConnection
}

/** Result of `advance`. */
export type ServiceAdvance =
  | ({ ok: true } & ServiceFlow)
  | ({
      ok: false
      error: 'stale-view' | 'expired' | 'finished' | 'invalid-action' | 'not-found'
      message: string
    } & Partial<ServiceFlow>)

/** Parameters of `startConnect`. */
export interface StartConnectParams {
  definitionId: string
  scope: ConnectorScope
  scopeId?: string
  label?: string
  /** Workspace and user scope: every agent inherits the connection. Default: the connector's scope default, else `false` (agent scope: `true`). */
  defaultEnabled?: boolean
}

/** What `update` may change. Secrets in `settings` follow `mergeSecretPatch`. */
export interface ConnectionPatch {
  label?: string
  enabled?: boolean
  defaultEnabled?: boolean
  defaultModes?: Record<string, CapabilityMode>
  /** A settings patch: absent keeps, secrets `''` / `{ keep: true }` keep, `null` removes. */
  settings?: Record<string, unknown>
}

/** What an application's routes call. */
export interface ConnectorService {
  /** What a UI shows of each connector (no functions, no secrets). */
  catalog(): ConnectorDescription[]
  list(query?: {
    scope?: ConnectorScope
    scopeId?: string
    definitionId?: string
  }): Promise<PublicConnection[]>
  get(id: string): Promise<PublicConnection | undefined>
  /** Start a connect flow. */
  startConnect(params: StartConnectParams): Promise<ServiceFlow>
  /** Reconnect (re-authorize) a connection. */
  reconnect(connectionId: string): Promise<ServiceFlow>
  /** The current state of a flow (a reload resumes here). */
  getFlow(flowId: string): Promise<ServiceFlow | undefined>
  advance(flowId: string, input: FlowInput): Promise<ServiceAdvance>
  /** The app's OAuth callback route: deliver `state` and `code` (or `error`). */
  completeOAuth(callback: OAuthCallback): Promise<ServiceAdvance>
  update(id: string, patch: ConnectionPatch): Promise<PublicConnection>
  /** Delete a connection, its credentials and every agent's entry for it. */
  remove(id: string): Promise<void>
  enablement(agentId: string): Promise<AgentEnablement>
  setEnablement(
    agentId: string,
    connectionId: string,
    value: ConnectionEnablement | undefined,
  ): Promise<void>
  /** Run the connector's test and record the status. */
  test(id: string): Promise<ConnectorTestResult>
  /** A fresh access token (server side only; never send it to a browser). */
  accessToken(connectionId: string): Promise<string>
  /** `activateConnectors` over the stored connections and one agent's enablement. */
  activate(
    options: Omit<ActivateOptions, 'definitions' | 'connections' | 'enablement' | 'accessToken'>,
  ): Promise<ActivatedConnectors>
  /** Delete expired flows. */
  sweep(): Promise<number>
}

const DONE_KEEP_MS = 5 * 60_000

/** Create a {@link ConnectorService}. */
export function createConnectorService(options: ConnectorServiceOptions): ConnectorService {
  const now = options.now ?? Date.now
  const defs = new Map(options.definitions.map((d) => [d.id, d]))
  const flowDeps: FlowDeps = {
    definitions: options.definitions,
    vault: options.vault,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
    ...(options.clientConfig === undefined ? {} : { clientConfig: options.clientConfig }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  }
  const ids = resolveFlowDeps(flowDeps)
  const manager = createCredentialManager({
    credentials: options.credentials,
    connections: options.connections,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  })

  const definitionOf = (id: string): AnyConnectorDefinition => {
    const def = defs.get(id)
    if (def === undefined) throw connectorError('unknown-definition', `Unknown connector '${id}'.`)
    return def
  }

  async function toPublic(record: ConnectionRecord): Promise<PublicConnection> {
    const def = defs.get(record.definitionId)
    const authorized = (await options.credentials.get(record.id))?.tokens !== undefined
    if (def === undefined) {
      const { settings: _drop, ...rest } = structuredClone(record)
      return { ...rest, settings: {}, authorized } as PublicConnection
    }
    return publicConnection(def, record, { authorized })
  }

  /** Save the connection a finished flow produced and keep the flow briefly for pollers. */
  async function finalize(state: FlowState): Promise<ServiceFlow> {
    const done = await flowCompletion(state, flowDeps)
    const def = definitionOf(done.definitionId)
    const existing =
      done.connectionId === undefined ? undefined : await options.connections.get(done.connectionId)
    const id = existing?.id ?? `conn_${ids.newId()}`
    const t = now()
    const defaults = def.scopeDefaults?.[done.scope]
    const record: ConnectionRecord = {
      ...(existing ?? {
        kind: 'connection' as const,
        definitionId: def.id,
        createdAt: t,
        enabled: true,
      }),
      id,
      kind: 'connection',
      definitionId: def.id,
      label: existing?.label ?? done.label,
      settings: done.settings,
      enabled: existing?.enabled ?? true,
      scope: done.scope,
      ...(done.scopeId === undefined ? {} : { scopeId: done.scopeId }),
      status: 'connected',
      ...(done.accountLabel === undefined
        ? existing?.accountLabel === undefined
          ? {}
          : { accountLabel: existing.accountLabel }
        : { accountLabel: done.accountLabel }),
      defaultEnabled:
        existing?.defaultEnabled ??
        done.defaultEnabled ??
        defaults?.defaultEnabled ??
        done.scope === 'agent',
      ...(existing?.defaultModes === undefined
        ? defaults?.defaultModes === undefined
          ? {}
          : { defaultModes: { ...defaults.defaultModes } }
        : { defaultModes: existing.defaultModes }),
      choices: done.choices,
      ...(done.capabilities === undefined
        ? existing?.capabilities === undefined
          ? {}
          : { capabilities: existing.capabilities }
        : { capabilities: done.capabilities }),
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    } as ConnectionRecord
    delete (record as { statusMessage?: string }).statusMessage
    if (done.credentials !== undefined) await options.credentials.put(id, done.credentials)
    await options.connections.put(record)
    // keep the finished flow briefly (a polling tab learns the outcome), without its scratch
    const kept: FlowState = {
      ...state,
      connectionId: id,
      expiresAt: t + DONE_KEEP_MS,
      sealed: await options.vault.seal('{}', `flow:${state.id}`),
    }
    await options.flows.put(kept)
    return { flow: publicFlow(kept), connection: await toPublic(record) }
  }

  async function settled(state: FlowState): Promise<ServiceFlow> {
    if (state.status === 'done') return finalize(state)
    await options.flows.put(state)
    return { flow: publicFlow(state) }
  }

  async function asAdvance(
    result: Awaited<ReturnType<typeof advanceFlow>>,
  ): Promise<ServiceAdvance> {
    if (result.ok) return { ok: true, ...(await settled(result.state)) }
    const flow = publicFlow(result.state)
    const connection =
      result.state.connectionId === undefined
        ? undefined
        : await options.connections.get(result.state.connectionId)
    return {
      ok: false,
      error: result.error,
      message: result.message,
      flow,
      ...(result.error === 'finished' && connection !== undefined
        ? { connection: await toPublic(connection) }
        : {}),
    }
  }

  return {
    catalog: () => options.definitions.map(describeConnector),
    list: async (query) => Promise.all((await options.connections.list(query)).map(toPublic)),
    get: async (id) => {
      const record = await options.connections.get(id)
      return record === undefined ? undefined : toPublic(record)
    },
    startConnect: async (params) => {
      const state = await startFlow(
        {
          definition: definitionOf(params.definitionId),
          scope: params.scope,
          ...(params.scopeId === undefined ? {} : { scopeId: params.scopeId }),
          ...(params.label === undefined ? {} : { label: params.label }),
          ...(params.defaultEnabled === undefined ? {} : { defaultEnabled: params.defaultEnabled }),
        },
        flowDeps,
      )
      return settled(state)
    },
    reconnect: async (connectionId) => {
      const record = await options.connections.get(connectionId)
      if (record === undefined)
        throw connectorError('not-found', `Unknown connection '${connectionId}'.`)
      const state = await startFlow(
        {
          definition: definitionOf(record.definitionId),
          scope: record.scope,
          ...(record.scopeId === undefined ? {} : { scopeId: record.scopeId }),
          connection: record,
        },
        flowDeps,
      )
      return settled(state)
    },
    getFlow: async (flowId) => {
      const state = await options.flows.get(flowId)
      if (state === undefined) return undefined
      const connection =
        state.connectionId === undefined
          ? undefined
          : await options.connections.get(state.connectionId)
      return {
        flow: publicFlow(state),
        ...(state.status === 'done' && connection !== undefined
          ? { connection: await toPublic(connection) }
          : {}),
      }
    },
    advance: async (flowId, input) => {
      const state = await options.flows.get(flowId)
      if (state === undefined)
        return { ok: false, error: 'not-found', message: 'The flow does not exist or expired.' }
      return asAdvance(await advanceFlow(state, input, flowDeps))
    },
    completeOAuth: async (callback) => {
      const result = await completeOAuth(callback, options.flows, flowDeps)
      if (!result.ok && result.error === 'unknown-state') {
        return { ok: false, error: 'not-found', message: result.message }
      }
      // completeOAuth stored the new state; finish the connection when the flow is done
      return asAdvance(result as Awaited<ReturnType<typeof advanceFlow>>)
    },
    update: async (id, patch) => {
      const record = await options.connections.get(id)
      if (record === undefined) throw connectorError('not-found', `Unknown connection '${id}'.`)
      const def = definitionOf(record.definitionId)
      const next: ConnectionRecord = { ...record, updatedAt: now() }
      if (patch.label !== undefined) next.label = patch.label
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.defaultEnabled !== undefined) next.defaultEnabled = patch.defaultEnabled
      if (patch.defaultModes !== undefined) next.defaultModes = { ...patch.defaultModes }
      if (patch.settings !== undefined) {
        const schema = connectorSchema(def)
        const merged = mergeSecretPatch(schema, record.settings, patch.settings)
        next.settings = validateSettings(schema, merged, `settings of '${record.label}'`)
      }
      await options.connections.put(next)
      return toPublic(next)
    },
    remove: async (id) => {
      await options.connections.delete(id)
      await options.credentials.delete(id)
      await options.enablement.removeConnection(id)
    },
    enablement: (agentId) => options.enablement.get(agentId),
    setEnablement: (agentId, connectionId, value) =>
      options.enablement.set(agentId, connectionId, value),
    test: async (id) => {
      const record = await options.connections.get(id)
      if (record === undefined) throw connectorError('not-found', `Unknown connection '${id}'.`)
      const def = definitionOf(record.definitionId)
      const parsed = connectorSchema(def).safeParse(record.settings)
      const save = async (patch: Partial<ConnectionRecord>): Promise<void> => {
        await options.connections.put({ ...record, ...patch, updatedAt: now() })
      }
      if (!parsed.success) {
        await save({ status: 'error', statusMessage: 'The settings are invalid.' })
        return { ok: false, message: 'The settings are invalid.' }
      }
      if (def.test === undefined) return { ok: true }
      let accessToken: string | undefined
      if (def.auth.type === 'oauth2' || def.auth.type === 'deviceCode') {
        try {
          accessToken = await manager.getAccessToken(id)
        } catch {
          if (
            def.auth.type === 'oauth2' &&
            def.auth.when?.(parsed.data as Record<string, unknown>) === false
          ) {
            // the connector does not use OAuth with these settings
          } else {
            return { ok: false, message: 'Reconnect required.' }
          }
        }
      }
      let result: ConnectorTestResult
      try {
        result = await def.test({
          settings: parsed.data as Record<string, unknown>,
          choices: record.choices ?? {},
          accessToken,
          fetch: options.fetch ?? globalThis.fetch,
        })
      } catch (error) {
        result = {
          ok: false,
          message: error instanceof Error ? error.message.slice(0, 200) : 'The test failed.',
        }
      }
      await save(
        result.ok
          ? {
              status: 'connected',
              ...(result.accountLabel === undefined ? {} : { accountLabel: result.accountLabel }),
              ...(result.capabilities === undefined ? {} : { capabilities: result.capabilities }),
            }
          : { status: 'error', statusMessage: result.message ?? 'The connection test failed.' },
      )
      return result
    },
    accessToken: (connectionId) => manager.getAccessToken(connectionId),
    activate: async (opts) =>
      activateConnectors({
        ...opts,
        definitions: options.definitions,
        connections: await options.connections.list(),
        enablement: await options.enablement.get(opts.agent.id),
        accessToken: manager.getAccessToken,
        ...(opts.fetch === undefined && options.fetch !== undefined
          ? { fetch: options.fetch }
          : {}),
      }),
    sweep: () => options.flows.deleteExpired(now()),
  }
}
