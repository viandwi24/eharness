/**
 * Composition root: the only place that wires domain, app, infra and http together.
 *
 *   TEAM_DB     database file (default ./data/team.db; `:memory:` works)
 *   TEAM_TOKEN  bearer token; unset = open (localhost only, never expose such a server)
 *   PORT        default 4000
 *   OPENROUTER_API_KEY | AI_GATEWAY_API_KEY   read-only env provider profiles (more profiles are
 *                     added in Settings > Providers and stored encrypted); TEAM_SCRIPTED_MODEL wins over all
 *   TEAM_PROVIDER / TEAM_MODEL   default profile (openrouter | gateway) and its default model
 *   TEAM_SECRET_KEY   32 bytes base64: encrypts provider secrets, connection secrets and tokens at rest (dev: a key file next to the DB)
 *   TEAM_PUBLIC_URL   where this server is reached by the browser (OAuth callback `<url>/oauth/callback`; default http://localhost:PORT)
 *   TEAM_WEB_URL      where the web app lives (the OAuth callback redirects to `<url>/connectors`; default http://localhost:5173)
 *   TEAM_<CONNECTOR>_CLIENT_ID / _CLIENT_SECRET   OAuth app of a curated connector (e.g. TEAM_GITHUB_CLIENT_ID); or save it in the web app
 *   TEAM_CLASSIFIER_MODEL   model of Auto permission mode, `profile:model` or a plain id (default: the default model; none with a scripted model)
 *   TEAM_SEARCH_MODEL   model of web_search, same format
 *   TEAM_INSTANCE_ID  stable id of this instance (default team-<PORT>): a restarted instance recovers its own interrupted turns at boot
 *   TEAM_BUDGET_USD   monthly USD limit of the workspace ledger (unset = tracked, not limited)
 *   TEAM_SPAWN_CAP    children the lead runs at once (default 4; the settings row overrides it)
 *   TEAM_OFFLINE      1 = never fetch the model catalogs (cached in the database, refreshed every 24 h)
 *   TEAM_ROUTINE_TICK_MS   routine ticker interval (default 15000; 0 = off)
 *   TEAM_LOG_MAX_ROWS / TEAM_LOG_RETENTION_DAYS   model call log retention (default 5000 rows, 7 days)
 *   TEAM_EVENTS_RETENTION_HOURS / TEAM_EVENTS_MAX_ROWS   events feed retention (default 72 h, 100000 rows; 0 hours = by count only)
 */
import { dirname } from 'node:path'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { ModelCatalog } from 'eharness'
import { type SecretVault, sealedProfileStore } from 'eharness/providers'
import type { Deps } from './app/ports.ts'
import { seedAgents } from './app/seed.ts'
import { newId } from './domain/ids.ts'
import { areaOf } from './domain/library.ts'
import { createApp } from './http/app.ts'
import { drizzleAgentRepo } from './infra/db/agents-repo.ts'
import { sqliteChatTools } from './infra/db/chat-tools-repo.ts'
import { type Connection, openDatabase } from './infra/db/client.ts'
import { sqliteModelCallStore } from './infra/db/model-calls-repo.ts'
import { sqliteSessionModes } from './infra/db/modes-repo.ts'
import { sqliteRoutineStore } from './infra/db/routines-repo.ts'
import { sqliteSettingsStore } from './infra/db/settings-repo.ts'
import { sqliteTaskStore } from './infra/db/tasks-repo.ts'
import { type ActivityLog, createActivityLog } from './infra/eh/activity-log.ts'
import {
  type AgentFactory,
  type AgentFactoryDeps,
  createAgentFactory,
  type TeamLimits,
} from './infra/eh/agent-factory.ts'
import { createChangeFeed } from './infra/eh/change-feed.ts'
import { createChatService } from './infra/eh/chat-service.ts'
import { createChatToolsService } from './infra/eh/chat-tools-service.ts'
import type { CatalogOptions } from './infra/eh/connector-catalog.ts'
import { type ConnectorsRuntime, createConnectors, SEALED_KINDS } from './infra/eh/connectors.ts'
import { backfillCustomSlugs, migrateLegacyAgents } from './infra/eh/connectors-migration.ts'
import type { LibraryChange } from './infra/eh/library-fs.ts'
import { sqliteLibraryStore } from './infra/eh/library-store.ts'
import { createModeService } from './infra/eh/mode-service.ts'
import { sqliteProfileStore } from './infra/eh/profile-store.ts'
import {
  type ModelConfig,
  providerModelConfig,
  scriptedModelConfigFromEnv,
} from './infra/eh/provider.ts'
import { createProviderService, PROVIDER_KIND, type ProviderService } from './infra/eh/providers.ts'
import {
  createRoutineService,
  type RoutineEngineConfig,
  type RoutineService,
} from './infra/eh/routine-service.ts'
import { teamVaultFromEnv } from './infra/eh/secret-vault.ts'
import { setBudgetLimit, sqliteLock } from './infra/eh/storage.ts'
import {
  createTeamService,
  type ReconcileReport,
  type TeamService,
} from './infra/eh/team-service.ts'
import { sqliteUploadStore } from './infra/eh/upload-store.ts'
import { croneSchedule } from './infra/schedule.ts'

export interface ServerConfig {
  dbFile: string
  token?: string | undefined
  /** Skip seeding (tests that start empty). */
  seed?: boolean
  /** Model config override (tests); default from the environment. */
  models?: ModelConfig
  /** Context windows and prices of models; default: the catalog of the provider manager. */
  catalog?: ModelCatalog
  /** Environment of the provider profiles (default `process.env`); tests pass `{}`. */
  env?: Record<string, string | undefined>
  /** The secret vault (default: `TEAM_SECRET_KEY`, else a dev key file next to the DB). */
  vault?: SecretVault
  /**
   * Stable id of this instance (default `TEAM_INSTANCE_ID`, else `team-<port>` when started as a
   * server): a restarted instance recovers its own orphaned turns at once.
   */
  instanceId?: string
  /** Never fetch the public model catalogs (default: `TEAM_OFFLINE=1`). */
  offline?: boolean
  /** The fetch of model lists, connection tests and catalogs (default: global). */
  fetch?: typeof fetch
  /** Poll interval of the change feed shared by providers and connectors (ms, default 1000; 0 = off). */
  changePollMs?: number
  /** Lists the tools of a remote MCP server when a connection is tested (tests inject a fake). */
  mcpListTools?: CatalogOptions['listTools']
  /** Public URL of this server (OAuth redirect URI base). Default `TEAM_PUBLIC_URL`, else `http://localhost:4000`. */
  publicUrl?: string
  /** URL of the web app (the OAuth callback redirects there). Default `TEAM_WEB_URL`, else `http://localhost:5173`. */
  webUrl?: string
  /** Auto mode classifier override (tests); default: the model of `models.classifierModel`. */
  classifier?: AgentFactoryDeps['classifier']
  /** Timers of the stream log and inbox (tests shorten them). */
  tuning?: AgentFactoryDeps['tuning']
  /** Delegation limits (spawn cap, child steps, park timeout). */
  limits?: TeamLimits
  /** Monthly USD limit of the workspace ledger scope. */
  budgetUsd?: number
  /** Model call log retention: rows kept (default 5000) and days kept (default 7). */
  logs?: { maxRows?: number; retentionDays?: number; jsonCap?: number }
  /** Poll interval of the SSE events feed (ms, default 500). */
  eventsPollMs?: number
  /**
   * Events table retention: hours kept (default 72) and rows kept (default 100 000), pruned at
   * boot and every `pruneEveryMs` (default 10 min; 0 = never again). `retentionHours: 0` keeps by count only.
   */
  events?: { retentionHours?: number; maxRows?: number; pruneEveryMs?: number }
  /** Routine ticker (interval, lookahead, grace, recovery). `tickMs: 0` = no timer. */
  routines?: RoutineEngineConfig
  /**
   * Repair pass (`reconcileSubagentWaits` + task drift): at boot (default on) and every
   * `everyMs` (default 60 000; 0 = never).
   */
  reconcile?: { onBoot?: boolean; everyMs?: number }
}

export interface Server {
  app: OpenAPIHono
  deps: Deps
  conn: Connection
  factory: AgentFactory
  team: TeamService
  routines: RoutineService
  /** The model call log writer (the `model.call` plugin and the classifier observer). */
  activityLog: ActivityLog
  /** Connectors: connections, flows, enablement, activation. */
  connectors: ConnectorsRuntime
  /** Resolves when the legacy migration ran and the connectors of every agent are activated. */
  connectorsReady: Promise<void>
  /** The provider manager behind `GET /providers` and the model port. */
  providers: ProviderService
  /** Resolves when the provider profiles and catalogs are loaded (await before serving chats). */
  providersReady: Promise<void>
  /** Resolves when the boot repair pass finished. */
  ready: Promise<void>
  /** Run the repair pass now (idempotent; every instance may run it). */
  reconcile(): Promise<ReconcileReport>
  close(): Promise<void>
}

export const WORKSPACE_ID = 'default'

export function compose(config: ServerConfig): Server {
  const conn = openDatabase(config.dbFile)
  const agents = drizzleAgentRepo(conn.db)

  const tasks = sqliteTaskStore(conn.sqlite)
  const events = {
    append: (e: Parameters<typeof tasks.appendEvent>[0]) => tasks.appendEvent(e, Date.now()),
  }
  // ONE vault, ONE profile table and ONE sealing path: provider profiles, connections, their
  // credentials and OAuth app credentials all go through `sealedProfileStore`. Rows written by
  // earlier versions (legacy `v1:` blobs) open through the vault's legacy reader and are
  // re-sealed in the background below.
  const instance = crypto.randomUUID()
  const vault =
    config.vault ??
    teamVaultFromEnv({
      ...(config.env === undefined ? {} : { env: config.env }),
      dataDir: config.dbFile === ':memory:' ? undefined : dirname(config.dbFile),
    })
  let connectorsRef: ConnectorsRuntime | undefined
  const profileStore = sealedProfileStore(
    sqliteProfileStore(conn.sqlite, {
      onChange: ({ kind, id, action }) => {
        if (kind === PROVIDER_KIND) {
          events.append({ type: 'providers-changed', payload: { profileId: id, action, instance } })
        } else if (kind === 'connection') {
          // appends `connectors-changed` and bumps the local revision
          connectorsRef?.profileChanged(kind)
        }
      },
    }),
    vault,
    {
      kinds: [PROVIDER_KIND, ...SEALED_KINDS],
      // a row whose key was lost is skipped (and says so), never fatal for the others
      onUnreadable: ({ kind, id, error }) =>
        console.warn(
          `team: ${kind} "${id}" is unreadable and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
    },
  )
  // one poller of the event feed for every kind of configuration change
  const changes = createChangeFeed({
    feed: tasks,
    instance,
    ...(config.changePollMs === undefined ? {} : { pollMs: config.changePollMs }),
  })
  // model providers: env profiles + encrypted profiles from the web; TEAM_SCRIPTED_MODEL wins
  const providers = createProviderService({
    sqlite: conn.sqlite,
    store: profileStore,
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.offline === undefined ? {} : { offline: config.offline }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    changes,
  })
  const models: ModelConfig =
    config.models ?? scriptedModelConfigFromEnv(config.env) ?? providerModelConfig(providers)
  // profiles and catalogs load in the background; `resolve` needs them (main awaits this)
  const providersReady = providers.ready()
  providersReady.catch(() => undefined)

  // every change of a library file (agents, uploads, people) reaches the event feed
  const onFileChange = (c: LibraryChange): void => {
    events.append({
      type: 'file-changed',
      agentId: c.agentId,
      payload: {
        action: c.action,
        path: c.path,
        ...(c.to === undefined ? {} : { to: c.to }),
        version: c.version,
        area: areaOf(c.path),
      },
    })
  }
  const modelCalls = sqliteModelCallStore(conn.sqlite, {
    ...(config.logs?.jsonCap === undefined ? {} : { jsonCap: config.logs.jsonCap }),
  })
  const activityLog = createActivityLog({
    store: modelCalls,
    tasks,
    agentOf: (slug) => agents.getBySlug(slug),
    ...(config.logs?.maxRows === undefined ? {} : { maxRows: config.logs.maxRows }),
    ...(config.logs?.retentionDays === undefined
      ? {}
      : { retentionDays: config.logs.retentionDays }),
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  activityLog.prune()
  const eventsRetentionMs = (config.events?.retentionHours ?? 72) * 3_600_000
  const eventsMaxRows = config.events?.maxRows ?? 100_000
  const pruneEvents = (): void => {
    try {
      tasks.pruneEvents({
        ...(eventsRetentionMs > 0 ? { before: Date.now() - eventsRetentionMs } : {}),
        maxRows: eventsMaxRows,
      })
    } catch (error) {
      console.warn(`team: pruning events failed: ${String(error)}`)
    }
  }
  pruneEvents()
  const pruneEveryMs = config.events?.pruneEveryMs ?? 600_000
  const pruneTimer = pruneEveryMs > 0 ? setInterval(pruneEvents, pruneEveryMs) : undefined
  pruneTimer?.unref()
  const settings = sqliteSettingsStore(conn.sqlite, {
    defaults: {
      toolAccess: 'auto',
      defaultPermissionMode: 'default',
      budgetUsd: config.budgetUsd ?? null,
      spawnCap: config.limits?.spawnCap ?? 4,
      defaultModel: null,
      defaultProfile: null,
    },
    // the limit is a row of the shared ledger: apply it now; other instances read the row
    onChange: (s) => setBudgetLimit(conn.sqlite, `workspace:${WORKSPACE_ID}`, s.budgetUsd),
  })
  const publicUrl = (
    config.publicUrl ??
    process.env.TEAM_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? 4000}`
  ).replace(/\/$/, '')
  const webUrl = (config.webUrl ?? process.env.TEAM_WEB_URL ?? 'http://localhost:5173').replace(
    /\/$/,
    '',
  )
  const connectors = createConnectors({
    sqlite: conn.sqlite,
    profiles: profileStore,
    vault,
    lock: sqliteLock(conn.sqlite),
    agentById: (id) => agents.get(id),
    agents: () => agents.list(),
    ...(models.search === undefined ? {} : { search: models.search }),
    ...(config.mcpListTools === undefined ? {} : { listTools: config.mcpListTools }),
    onFileChange,
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    redirectUri: `${publicUrl}/oauth/callback`,
    events,
    changes,
    toolAccess: () => settings.get().toolAccess,
    instance,
  })
  connectorsRef = connectors
  const routineStore = sqliteRoutineStore(conn.sqlite)
  const sessionModes = sqliteSessionModes(conn.sqlite)
  const chatToolsStore = sqliteChatTools(conn.sqlite)
  let routines: RoutineService | undefined
  const factory = createAgentFactory({
    sqlite: conn.sqlite,
    models,
    connectors,
    ...(config.catalog === undefined ? {} : { catalog: config.catalog }),
    workspaceId: WORKSPACE_ID,
    roster: () => agents.list().filter((a) => a.role === 'role' || a.role === 'custom'),
    lead: () => agents.list().find((a) => a.role === 'lead'),
    agentBySlug: (slug) => agents.getBySlug(slug),
    agentById: (id) => agents.get(id),
    ...(config.classifier === undefined ? {} : { classifier: config.classifier }),
    sessionModes,
    chatTools: chatToolsStore,
    // Auto blocked / paused / resumed: the web shows "auto paused" from this event
    onAutoEvent: ({ sessionId, agentId, event, state, mode }) =>
      events.append({
        type: 'mode-changed',
        agentId,
        sessionId,
        payload: {
          mode,
          autoPaused: state.paused,
          auto: event.type,
          ...(event.type === 'blocked' || event.type === 'unavailable'
            ? { tool: event.toolName, reason: event.reason }
            : {}),
        },
      }),
    taskStore: tasks,
    activityLog,
    settings: () => {
      const s = settings.get()
      return { ...s, rev: s.updatedAt }
    },
    routineOutcomes: () => routines?.outcomes,
    onFileChange,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
    onWarning: (w) => {
      // scripted (offline) models have no prices
      if (w.code === 'W_MODEL_UNPRICED' && models.provider === 'scripted') return
      console.warn(`eharness warning ${w.code}: ${w.message}`)
    },
    ...(config.tuning === undefined ? {} : { tuning: config.tuning }),
    ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
  })
  const team = createTeamService(factory, {
    agents,
    tasks,
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const schedule = croneSchedule()
  routines = createRoutineService(factory, {
    agents,
    routines: routineStore,
    schedule,
    tasks,
    ...(config.routines === undefined ? {} : { config: config.routines }),
    log: { warn: (message) => console.warn(message) },
  })
  const deps: Deps = {
    agents,
    chat: createChatService(factory, { workspaceId: WORKSPACE_ID }),
    chatTools: createChatToolsService({
      store: chatToolsStore,
      agentConnectors: (agent) => connectors.agentConnectors(agent),
    }),
    uploads: sqliteUploadStore(conn.sqlite, { onChange: onFileChange }),
    tasks,
    team,
    library: sqliteLibraryStore(conn.sqlite, { onChange: onFileChange }),
    settings,
    providers,
    connectors,
    webUrl,
    modes: createModeService(factory, {
      store: sessionModes,
      workspaceDefault: () => settings.get().defaultPermissionMode,
    }),
    routines: routineStore,
    schedule,
    routineEngine: routines,
    events,
    modelCalls,
    clock: { now: () => Date.now() },
    ids: { next: () => newId() },
    workspaceId: WORKSPACE_ID,
    ...(config.eventsPollMs === undefined ? {} : { eventsPollMs: config.eventsPollMs }),
  }
  if (config.seed !== false) seedAgents(deps)

  // one repair pass at a time per instance; safe to run on several instances at once
  let repairing: Promise<ReconcileReport> | undefined
  const reconcile = (): Promise<ReconcileReport> => {
    repairing ??= team.reconcile().finally(() => {
      repairing = undefined
    })
    return repairing
  }
  const quiet = (): Promise<void> =>
    reconcile().then(
      () => undefined,
      (error) => console.warn(`team: reconcile failed: ${String(error)}`),
    )
  // agents from before connectors get their enablement, then every agent's connectors activate
  const connectorsReady = providersReady.then(async () => {
    // legacy `v1:` blobs (and rows of a rotated-out key) are rewritten with the current key
    const resealed = await profileStore.reseal()
    if (resealed > 0)
      console.warn(`team: re-sealed ${resealed} stored secret row(s) with the current key`)
    await migrateLegacyAgents({
      sqlite: conn.sqlite,
      connections: connectors.stores.connections,
      changed: () => connectors.profileChanged('connection'),
    })
    await backfillCustomSlugs({
      connections: connectors.stores.connections,
      changed: () => connectors.profileChanged('connection'),
    })
    await factory.prepare()
  })
  connectorsReady.catch(() => undefined)
  // the repair pass opens sessions, which needs the provider profiles and connectors
  const ready =
    config.reconcile?.onBoot === false ? Promise.resolve() : connectorsReady.then(quiet, quiet)
  const everyMs = config.reconcile?.everyMs ?? 60_000
  const timer = everyMs > 0 ? setInterval(() => void quiet(), everyMs) : undefined
  timer?.unref()

  const app = createApp({ deps, token: config.token })
  routines.start()
  return {
    app,
    deps,
    conn,
    factory,
    team,
    routines,
    activityLog,
    providers,
    providersReady,
    connectors,
    connectorsReady,
    ready,
    reconcile,
    async close() {
      if (timer !== undefined) clearInterval(timer)
      if (pruneTimer !== undefined) clearInterval(pruneTimer)
      await routines?.stop()
      await ready
      await repairing?.catch(() => undefined)
      await factory.close()
      changes.close()
      providers.close()
      connectors.close()
      await connectorsReady.catch(() => undefined)
      await providersReady.catch(() => undefined)
      conn.close()
    },
  }
}

if (import.meta.main) {
  const token = process.env.TEAM_TOKEN
  const budget = Number(process.env.TEAM_BUDGET_USD)
  const spawnCap = Number(process.env.TEAM_SPAWN_CAP)
  const tickMs = Number(process.env.TEAM_ROUTINE_TICK_MS)
  const logRows = Number(process.env.TEAM_LOG_MAX_ROWS)
  const logDays = Number(process.env.TEAM_LOG_RETENTION_DAYS)
  const eventHours = Number(process.env.TEAM_EVENTS_RETENTION_HOURS)
  const eventRows = Number(process.env.TEAM_EVENTS_MAX_ROWS)
  const dbFile = process.env.TEAM_DB ?? './data/team.db'
  const listenPort = Number(process.env.PORT ?? 4000)
  const server = compose({
    dbFile,
    instanceId: process.env.TEAM_INSTANCE_ID ?? `team-${listenPort}`,
    token,
    ...(Number.isFinite(budget) && budget > 0 ? { budgetUsd: budget } : {}),
    ...(Number.isFinite(spawnCap) && spawnCap > 0 ? { limits: { spawnCap } } : {}),
    logs: {
      ...(Number.isFinite(logRows) && logRows > 0 ? { maxRows: logRows } : {}),
      ...(Number.isFinite(logDays) && logDays > 0 ? { retentionDays: logDays } : {}),
    },
    events: {
      ...(process.env.TEAM_EVENTS_RETENTION_HOURS !== undefined &&
      Number.isFinite(eventHours) &&
      eventHours >= 0
        ? { retentionHours: eventHours }
        : {}),
      ...(Number.isFinite(eventRows) && eventRows > 0 ? { maxRows: eventRows } : {}),
    },
    ...(process.env.TEAM_ROUTINE_TICK_MS !== undefined && Number.isFinite(tickMs) && tickMs >= 0
      ? { routines: { tickMs } }
      : {}),
  })
  try {
    // profiles (decrypting them needs a valid TEAM_SECRET_KEY) and catalogs
    await server.providersReady
    await server.connectorsReady
  } catch (error) {
    console.error(
      `provider setup failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? 4000)
  const http = Bun.serve({ port, fetch: server.app.fetch })
  console.log(
    `team server on http://localhost:${http.port} (docs at /docs, ${token ? 'token auth' : 'OPEN: no TEAM_TOKEN set'})`,
  )
  const shutdown = async (): Promise<void> => {
    await http.stop()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
