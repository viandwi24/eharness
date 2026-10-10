/**
 * Composition root: the only place that wires domain, app, infra and http together.
 *
 *   TEAM_DB     database file (default ./data/team.db; `:memory:` works)
 *   TEAM_TOKEN  bearer token; unset = open (localhost only, never expose such a server)
 *   PORT        default 4000
 *   OPENROUTER_API_KEY | AI_GATEWAY_API_KEY | TEAM_SCRIPTED_MODEL   model provider (see infra/eh/provider.ts)
 *   TEAM_BUDGET_USD   monthly USD limit of the workspace ledger (unset = tracked, not limited)
 *   TEAM_SPAWN_CAP    children the lead runs at once (default 4; the settings row overrides it)
 *   TEAM_ROUTINE_TICK_MS   routine ticker interval (default 15000; 0 = off)
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Deps } from './app/ports.ts'
import { seedAgents } from './app/seed.ts'
import { newId } from './domain/ids.ts'
import { areaOf } from './domain/library.ts'
import { createApp } from './http/app.ts'
import { drizzleAgentRepo } from './infra/db/agents-repo.ts'
import { type Connection, openDatabase } from './infra/db/client.ts'
import { sqliteRoutineStore } from './infra/db/routines-repo.ts'
import { sqliteSettingsStore } from './infra/db/settings-repo.ts'
import { sqliteTaskStore } from './infra/db/tasks-repo.ts'
import {
  type AgentFactory,
  type AgentFactoryDeps,
  createAgentFactory,
  type TeamLimits,
} from './infra/eh/agent-factory.ts'
import { createChatService } from './infra/eh/chat-service.ts'
import type { LibraryChange } from './infra/eh/library-fs.ts'
import { sqliteLibraryStore } from './infra/eh/library-store.ts'
import { createModelConfig, type ModelConfig } from './infra/eh/provider.ts'
import {
  createRoutineService,
  type RoutineEngineConfig,
  type RoutineService,
} from './infra/eh/routine-service.ts'
import { setBudgetLimit } from './infra/eh/storage.ts'
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
  /** Timers of the stream log and inbox (tests shorten them). */
  tuning?: AgentFactoryDeps['tuning']
  /** Delegation limits (spawn cap, child steps, park timeout). */
  limits?: TeamLimits
  /** Monthly USD limit of the workspace ledger scope. */
  budgetUsd?: number
  /** Poll interval of the SSE events feed (ms, default 500). */
  eventsPollMs?: number
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

  let models = config.models
  if (models === undefined) {
    try {
      models = createModelConfig()
    } catch (error) {
      console.warn(`warning: ${error instanceof Error ? error.message : String(error)}`)
      console.warn('warning: chats are unavailable until a model provider is configured')
      const message = error instanceof Error ? error.message : String(error)
      models = {
        provider: 'scripted',
        defaultModel: 'none',
        resolve: () => {
          throw new Error(message)
        },
      }
    }
  }
  const tasks = sqliteTaskStore(conn.sqlite)
  const events = {
    append: (e: Parameters<typeof tasks.appendEvent>[0]) => tasks.appendEvent(e, Date.now()),
  }
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
  const settings = sqliteSettingsStore(conn.sqlite, {
    defaults: {
      defaultPermissionMode: 'default',
      budgetUsd: config.budgetUsd ?? null,
      spawnCap: config.limits?.spawnCap ?? 4,
      defaultModel: null,
    },
    // the limit is a row of the shared ledger: apply it now; other instances read the row
    onChange: (s) => setBudgetLimit(conn.sqlite, `workspace:${WORKSPACE_ID}`, s.budgetUsd),
  })
  const routineStore = sqliteRoutineStore(conn.sqlite)
  let routines: RoutineService | undefined
  const factory = createAgentFactory({
    sqlite: conn.sqlite,
    models,
    workspaceId: WORKSPACE_ID,
    roster: () => agents.list().filter((a) => a.role === 'role' || a.role === 'custom'),
    lead: () => agents.list().find((a) => a.role === 'lead'),
    agentBySlug: (slug) => agents.getBySlug(slug),
    taskStore: tasks,
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
    uploads: sqliteUploadStore(conn.sqlite, { onChange: onFileChange }),
    tasks,
    team,
    library: sqliteLibraryStore(conn.sqlite, { onChange: onFileChange }),
    settings,
    routines: routineStore,
    schedule,
    routineEngine: routines,
    events,
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
  const ready = config.reconcile?.onBoot === false ? Promise.resolve() : quiet()
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
    ready,
    reconcile,
    async close() {
      if (timer !== undefined) clearInterval(timer)
      await routines?.stop()
      await ready
      await repairing?.catch(() => undefined)
      await factory.close()
      conn.close()
    },
  }
}

if (import.meta.main) {
  const token = process.env.TEAM_TOKEN
  const budget = Number(process.env.TEAM_BUDGET_USD)
  const spawnCap = Number(process.env.TEAM_SPAWN_CAP)
  const tickMs = Number(process.env.TEAM_ROUTINE_TICK_MS)
  const server = compose({
    dbFile: process.env.TEAM_DB ?? './data/team.db',
    token,
    ...(Number.isFinite(budget) && budget > 0 ? { budgetUsd: budget } : {}),
    ...(Number.isFinite(spawnCap) && spawnCap > 0 ? { limits: { spawnCap } } : {}),
    ...(process.env.TEAM_ROUTINE_TICK_MS !== undefined && Number.isFinite(tickMs) && tickMs >= 0
      ? { routines: { tickMs } }
      : {}),
  })
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
