/**
 * The session of an agent for a node (docs/plans/P41-team-channels.md, phase L5). One session per
 * node and agent: `channel:<connection>:<node id>`, with `#<n>` for the n-th agent that took the
 * node over. A node that shares its room's session (the `sessionScope: 'room'` setting) has no row
 * of its own: the row belongs to the room. Nodes migrated from L1-L4 keep their old session key.
 */
import type { Database } from 'bun:sqlite'

export interface NodeSessionRow {
  connectionId: string
  /** The node that owns the session (the node itself, or the room it is shared with). */
  nodeId: string
  sessionId: string
  agentId: string
  label: string | null
  createdAt: number
  /** 0 for the first agent; bumped when the agent of the node changes. */
  generation: number
  /** The node the session answered in last. */
  lastNodeId: string | null
}

interface SessionDb {
  connection_id: string
  node_id: string
  session_id: string
  agent_id: string
  label: string | null
  created_at: number
  generation: number
  last_node_id: string | null
}

const toRow = (r: SessionDb): NodeSessionRow => ({
  connectionId: r.connection_id,
  nodeId: r.node_id,
  sessionId: r.session_id,
  agentId: r.agent_id,
  label: r.label,
  createdAt: r.created_at,
  generation: r.generation,
  lastNodeId: r.last_node_id,
})

/** `channel:<connectionId>:<node id>`; the n-th agent of a node gets `#n`. */
export const channelSessionId = (connectionId: string, nodeId: string, generation = 0): string =>
  `channel:${connectionId}:${nodeId}${generation > 0 ? `#${generation + 1}` : ''}`

export const isChannelSession = (sessionId: string): boolean => sessionId.startsWith('channel:')

export interface SessionStore {
  get(connectionId: string, nodeId: string): NodeSessionRow | undefined
  bySession(sessionId: string): NodeSessionRow | undefined
  list(connectionId?: string): NodeSessionRow[]
  /** Create the row when missing; an existing row keeps its session and agent. */
  ensure(
    row: { connectionId: string; nodeId: string; agentId: string; label: string | null },
    now: number,
  ): NodeSessionRow
  /** The agent of the node changed: it moves to a new session (and generation). */
  rebind(
    connectionId: string,
    nodeId: string,
    to: { agentId: string; sessionId: string; generation: number },
  ): NodeSessionRow | undefined
  /** The node was replaced by another (an id migration): its session follows. */
  move(connectionId: string, fromNodeId: string, toNodeId: string): void
  setLabel(connectionId: string, nodeId: string, label: string): void
  setLastNode(connectionId: string, nodeId: string, lastNodeId: string): void
}

export function sqliteSessionStore(sqlite: Database): SessionStore {
  const get = sqlite.query<SessionDb, [string, string]>(
    'SELECT * FROM ch_node_sessions WHERE connection_id = ? AND node_id = ?',
  )
  return {
    get(connectionId, nodeId) {
      const r = get.get(connectionId, nodeId)
      return r === null ? undefined : toRow(r)
    },
    bySession(sessionId) {
      const r = sqlite
        .query<SessionDb, [string]>('SELECT * FROM ch_node_sessions WHERE session_id = ?')
        .get(sessionId)
      return r === null ? undefined : toRow(r)
    },
    list(connectionId) {
      const rows =
        connectionId === undefined
          ? sqlite
              .query<SessionDb, []>('SELECT * FROM ch_node_sessions ORDER BY created_at, node_id')
              .all()
          : sqlite
              .query<SessionDb, [string]>(
                'SELECT * FROM ch_node_sessions WHERE connection_id = ? ORDER BY created_at, node_id',
              )
              .all(connectionId)
      return rows.map(toRow)
    },
    ensure(row, now) {
      sqlite
        .query(
          `INSERT INTO ch_node_sessions (connection_id, node_id, session_id, agent_id, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, node_id) DO UPDATE SET label = COALESCE(excluded.label, label)`,
        )
        .run(
          row.connectionId,
          row.nodeId,
          channelSessionId(row.connectionId, row.nodeId),
          row.agentId,
          row.label,
          now,
        )
      return toRow(get.get(row.connectionId, row.nodeId) as SessionDb)
    },
    rebind(connectionId, nodeId, to) {
      sqlite
        .query(
          'UPDATE ch_node_sessions SET agent_id = ?, session_id = ?, generation = ? WHERE connection_id = ? AND node_id = ?',
        )
        .run(to.agentId, to.sessionId, to.generation, connectionId, nodeId)
      const r = get.get(connectionId, nodeId)
      return r === null ? undefined : toRow(r)
    },
    move(connectionId, fromNodeId, toNodeId) {
      sqlite
        .query(
          'UPDATE ch_node_sessions SET node_id = ?, last_node_id = ? WHERE connection_id = ? AND node_id = ?',
        )
        .run(toNodeId, toNodeId, connectionId, fromNodeId)
    },
    setLabel(connectionId, nodeId, label) {
      sqlite
        .query('UPDATE ch_node_sessions SET label = ? WHERE connection_id = ? AND node_id = ?')
        .run(label, connectionId, nodeId)
    },
    setLastNode(connectionId, nodeId, lastNodeId) {
      sqlite
        .query(
          'UPDATE ch_node_sessions SET last_node_id = ? WHERE connection_id = ? AND node_id = ?',
        )
        .run(lastNodeId, connectionId, nodeId)
    },
  }
}
