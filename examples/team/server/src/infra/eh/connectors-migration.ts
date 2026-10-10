/**
 * Boot migration: agents from before connectors (`agents.connectors_migrated = 0`) get the
 * connector enablement that reproduces their tool checklist (`enablementFromTools`) and each of
 * their remote MCP servers becomes an agent-scoped custom connection (`mcp:<agent>:<name>`, headers
 * sealed like every connection secret). Idempotent and resumable: the connection ids are
 * deterministic, the agent is marked migrated last, the legacy columns are left untouched.
 */
import type { Database } from 'bun:sqlite'
import type { ConnectionRecord, ConnectionStore } from 'eharness/connectors'
import type { AgentConnectors } from '../../domain/connectors.ts'
import { enablementFromTools } from '../../domain/connectors.ts'
import type { LegacyMcpServer } from '../db/schema.ts'

interface LegacyRow {
  id: string
  role: string
  tools: string
  mcp_servers: string
}

export interface MigrationReport {
  agents: number
  mcpConnections: number
}

export async function migrateLegacyAgents(options: {
  sqlite: Database
  connections: ConnectionStore
  now?: () => number
  /** Called after the rows were written (revision bump / event). */
  changed?: () => void
}): Promise<MigrationReport> {
  const { sqlite } = options
  const now = (options.now ?? Date.now)()
  const rows = sqlite
    .query<LegacyRow, []>(
      'SELECT id, role, tools, mcp_servers FROM agents WHERE connectors_migrated = 0',
    )
    .all()
  const report: MigrationReport = { agents: 0, mcpConnections: 0 }
  for (const row of rows) {
    const tools = JSON.parse(row.tools) as string[]
    const servers = JSON.parse(row.mcp_servers) as LegacyMcpServer[]
    const enablement: AgentConnectors = enablementFromTools(tools, row)
    const mcpOn = tools.includes('mcp')
    for (const s of servers) {
      const id = `mcp:${row.id}:${s.name}`
      const headers = s.transport.headers ?? {}
      const hasHeaders = Object.keys(headers).length > 0
      const record: ConnectionRecord = {
        id,
        kind: 'connection',
        definitionId: 'mcp-remote',
        // the label is the tool prefix: `<name>_<tool>`, as before
        label: s.name,
        settings: {
          url: s.transport.url,
          authMode: hasHeaders ? 'headers' : 'none',
          ...(hasHeaders ? { headers } : {}),
          transport: s.transport.type,
          ...(s.allow === undefined ? {} : { allow: s.allow }),
          ...(s.deny === undefined ? {} : { deny: s.deny }),
        },
        enabled: true,
        scope: 'agent',
        scopeId: row.id,
        status: 'connected',
        defaultEnabled: true,
        createdAt: now,
        updatedAt: now,
      }
      await options.connections.put(record)
      // an agent without the `mcp` tool never used its servers: they stay, switched off
      enablement[id] = { enabled: mcpOn ? 'on' : 'off' }
      report.mcpConnections++
    }
    sqlite
      .transaction(() => {
        sqlite.query('DELETE FROM agent_connectors WHERE agent_id = ?').run(row.id)
        for (const [connectionId, choices] of Object.entries(enablement)) {
          sqlite
            .query(
              'INSERT INTO agent_connectors (agent_id, connection_id, choices, updated_at) VALUES (?, ?, ?, ?)',
            )
            .run(row.id, connectionId, JSON.stringify(choices), now)
        }
        sqlite.query('UPDATE agents SET connectors_migrated = 1 WHERE id = ?').run(row.id)
      })
      .immediate()
    report.agents++
  }
  if (report.agents > 0) options.changed?.()
  return report
}
