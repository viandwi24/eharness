import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AgentRepo } from '../../app/ports.ts'
import type { AgentDef, AgentRole, PermissionMode, ToolName } from '../../domain/agents.ts'
import type { Db } from './client.ts'
import { agents } from './schema.ts'

type Row = typeof agents.$inferSelect

const toDef = (row: Row): AgentDef => ({
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
  tools: row.tools as ToolName[],
  skills: row.skills,
  mcp: row.mcp,
  permissionMode: row.permissionMode as PermissionMode,
  rules: row.rules,
  version: row.version,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export function drizzleAgentRepo(db: Db): AgentRepo {
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
      return rows.map(toDef)
    },
    get(id) {
      const row = db.select().from(agents).where(eq(agents.id, id)).get()
      return row === undefined ? undefined : toDef(row)
    },
    getBySlug(slug) {
      const row = db.select().from(agents).where(eq(agents.slug, slug)).get()
      return row === undefined ? undefined : toDef(row)
    },
    insert(def) {
      db.insert(agents).values(def).run()
    },
    update(def, expectedVersion) {
      const rows = db
        .update(agents)
        .set(def)
        .where(and(eq(agents.id, def.id), eq(agents.version, expectedVersion)))
        .returning({ id: agents.id })
        .all()
      return rows.length === 1
    },
    count() {
      const row = db.select({ n: sql<number>`count(*)` }).from(agents).get()
      return row?.n ?? 0
    },
  }
}
