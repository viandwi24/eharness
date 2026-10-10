import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AgentRepo } from '../../app/ports.ts'
import type { AgentDef, AgentRole, PermissionMode } from '../../domain/agents.ts'
import type { Db } from './client.ts'
import { agentConnectors, agents } from './schema.ts'

type Row = typeof agents.$inferSelect

const toDef = (row: Row, connectors: AgentDef['connectors']): AgentDef => ({
  id: row.id,
  workspaceId: row.workspaceId,
  slug: row.slug,
  name: row.name,
  role: row.role as AgentRole,
  avatar: row.avatar,
  color: row.color,
  description: row.description,
  instructions: row.instructions,
  model: row.model,
  modelProfile: row.modelProfile,
  connectors,
  toolAccess: (row.toolAccess ?? null) as AgentDef['toolAccess'],
  skills: row.skills,
  permissionMode: row.permissionMode as PermissionMode,
  rules: row.rules,
  version: row.version,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** Columns of the legacy checklist stay at their defaults for rows written now. */
const toRow = (def: AgentDef) => {
  const { connectors: _connectors, ...rest } = def
  return { ...rest, tools: [], mcp: [], mcpServers: [] }
}

export function drizzleAgentRepo(db: Db): AgentRepo {
  const connectorsOf = (): Map<string, AgentDef['connectors']> => {
    const out = new Map<string, AgentDef['connectors']>()
    for (const r of db.select().from(agentConnectors).all()) {
      const entry = out.get(r.agentId) ?? {}
      entry[r.connectionId] = r.choices as AgentDef['connectors'][string]
      out.set(r.agentId, entry)
    }
    return out
  }
  const writeConnectors = (agentId: string, connectors: AgentDef['connectors'], now: number) => {
    db.delete(agentConnectors).where(eq(agentConnectors.agentId, agentId)).run()
    for (const [connectionId, choices] of Object.entries(connectors)) {
      db.insert(agentConnectors)
        .values({
          agentId,
          connectionId,
          choices: choices as Record<string, unknown>,
          updatedAt: now,
        })
        .run()
    }
  }
  return {
    list(opts = {}) {
      const rows = opts.includeArchived
        ? db.select().from(agents).orderBy(agents.createdAt, agents.id).all()
        : db
            .select()
            .from(agents)
            .where(isNull(agents.archivedAt))
            .orderBy(agents.createdAt, agents.id)
            .all()
      const all = connectorsOf()
      return rows.map((row) => toDef(row, all.get(row.id) ?? {}))
    },
    get(id) {
      const row = db.select().from(agents).where(eq(agents.id, id)).get()
      if (row === undefined) return undefined
      return toDef(row, connectorsOf().get(row.id) ?? {})
    },
    getBySlug(slug) {
      const row = db.select().from(agents).where(eq(agents.slug, slug)).get()
      if (row === undefined) return undefined
      return toDef(row, connectorsOf().get(row.id) ?? {})
    },
    insert(def) {
      db.transaction(() => {
        db.insert(agents)
          .values({ ...toRow(def), connectorsMigrated: 1 })
          .run()
        writeConnectors(def.id, def.connectors, def.updatedAt)
      })
    },
    update(def, expectedVersion) {
      const rows = db
        .update(agents)
        .set(toRow(def))
        .where(and(eq(agents.id, def.id), eq(agents.version, expectedVersion)))
        .returning({ id: agents.id })
        .all()
      return rows.length === 1
    },
    setConnectors(agentId, connectors, now) {
      writeConnectors(agentId, connectors, now)
    },
    count() {
      const row = db.select({ n: sql<number>`count(*)` }).from(agents).get()
      return row?.n ?? 0
    },
  }
}
