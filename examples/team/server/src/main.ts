/**
 * Composition root: the only place that wires domain, app, infra and http together.
 *
 *   TEAM_DB     database file (default ./data/team.db; `:memory:` works)
 *   TEAM_TOKEN  bearer token; unset = open (localhost only, never expose such a server)
 *   PORT        default 4000
 *   OPENROUTER_API_KEY | AI_GATEWAY_API_KEY | TEAM_SCRIPTED_MODEL   model provider (see infra/eh/provider.ts)
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Deps } from './app/ports.ts'
import { seedAgents } from './app/seed.ts'
import { newId } from './domain/ids.ts'
import { createApp } from './http/app.ts'
import { drizzleAgentRepo } from './infra/db/agents-repo.ts'
import { type Connection, openDatabase } from './infra/db/client.ts'
import {
  type AgentFactory,
  type AgentFactoryDeps,
  createAgentFactory,
} from './infra/eh/agent-factory.ts'
import { createChatService } from './infra/eh/chat-service.ts'
import { createModelConfig, type ModelConfig } from './infra/eh/provider.ts'
import { sqliteUploadStore } from './infra/eh/upload-store.ts'

export interface ServerConfig {
  dbFile: string
  token?: string | undefined
  /** Skip seeding (tests that start empty). */
  seed?: boolean
  /** Model config override (tests); default from the environment. */
  models?: ModelConfig
  /** Timers of the stream log and inbox (tests shorten them). */
  tuning?: AgentFactoryDeps['tuning']
}

export interface Server {
  app: OpenAPIHono
  deps: Deps
  conn: Connection
  factory: AgentFactory
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
  const factory = createAgentFactory({
    sqlite: conn.sqlite,
    models,
    roster: () => agents.list().filter((a) => a.role === 'role' || a.role === 'custom'),
    onWarning: (w) => console.warn(`eharness warning ${w.code}: ${w.message}`),
    ...(config.tuning === undefined ? {} : { tuning: config.tuning }),
  })
  const deps: Deps = {
    agents,
    chat: createChatService(factory, { workspaceId: WORKSPACE_ID }),
    uploads: sqliteUploadStore(conn.sqlite),
    clock: { now: () => Date.now() },
    ids: { next: () => newId() },
    workspaceId: WORKSPACE_ID,
  }
  if (config.seed !== false) seedAgents(deps)

  const app = createApp({ deps, token: config.token })
  return {
    app,
    deps,
    conn,
    factory,
    async close() {
      await factory.close()
      conn.close()
    },
  }
}

if (import.meta.main) {
  const token = process.env.TEAM_TOKEN
  const server = compose({ dbFile: process.env.TEAM_DB ?? './data/team.db', token })
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
