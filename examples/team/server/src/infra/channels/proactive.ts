/**
 * Proactive posts (docs/plans/P41-team-channels.md, phase L6): what an agent says without being
 * asked (a routine, the heartbeat, a program). The policy is a node setting (`proactive`, inherited
 * down the tree); this file is the store of posts held back (quiet hours, a digest collecting
 * them). The decisions are in the gateway (`gateway.proactive`). The text is sealed like the rest
 * of the channel log.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { SecretVault } from 'eharness/providers'

export interface ProactiveRow {
  id: string
  connectionId: string
  nodeId: string
  agentId: string
  body: string
  /** Identity ids (ours) to mention. */
  mentions: string[]
  status: 'held' | 'sent' | 'dropped'
  createdAt: number
  sentAt: number | null
}

interface ProactiveDb {
  id: string
  connection_id: string
  node_id: string
  agent_id: string
  body: string
  mentions: string
  status: string
  created_at: number
  sent_at: number | null
}

export interface ProactiveStore {
  hold(
    input: {
      connectionId: string
      nodeId: string
      agentId: string
      body: string
      mentions: string[]
    },
    now: number,
  ): Promise<ProactiveRow>
  /** Held rows of a node, oldest first. */
  held(nodeId: string): Promise<ProactiveRow[]>
  /** Nodes that have held rows. */
  heldNodes(): string[]
  markSent(ids: readonly string[], now: number): void
  /** Record a post that went out at once (the gap between pings counts from it). */
  recordSent(
    input: { connectionId: string; nodeId: string; agentId: string; mentions: string[] },
    now: number,
  ): void
  lastSentAt(nodeId: string): number | undefined
  /** Posts sent to a node since `since` (a digest or a ping each). */
  sentSince(nodeId: string, since: number): number
  purge(before: number): number
  clear(connectionId: string): void
}

export function sqliteProactiveStore(sqlite: Database, vault: SecretVault): ProactiveStore {
  const context = (id: string): string => `channel-proactive:${id}`
  const open = async (r: ProactiveDb): Promise<ProactiveRow> => ({
    id: r.id,
    connectionId: r.connection_id,
    nodeId: r.node_id,
    agentId: r.agent_id,
    body: r.body === '' ? '' : await vault.open(r.body, context(r.id)),
    mentions: JSON.parse(r.mentions) as string[],
    status: r.status as ProactiveRow['status'],
    createdAt: r.created_at,
    sentAt: r.sent_at,
  })
  return {
    async hold(input, now) {
      const id = uuidv7()
      const sealed = await vault.seal(input.body, context(id))
      sqlite
        .query(
          `INSERT INTO ch_proactive (id, connection_id, node_id, agent_id, body, mentions, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'held', ?)`,
        )
        .run(
          id,
          input.connectionId,
          input.nodeId,
          input.agentId,
          sealed,
          JSON.stringify(input.mentions),
          now,
        )
      return open(
        sqlite
          .query<ProactiveDb, [string]>('SELECT * FROM ch_proactive WHERE id = ?')
          .get(id) as ProactiveDb,
      )
    },
    async held(nodeId) {
      const rows = sqlite
        .query<ProactiveDb, [string]>(
          "SELECT * FROM ch_proactive WHERE node_id = ? AND status = 'held' ORDER BY created_at, id",
        )
        .all(nodeId)
      return Promise.all(rows.map(open))
    },
    heldNodes() {
      return sqlite
        .query<{ node_id: string }, []>(
          "SELECT DISTINCT node_id FROM ch_proactive WHERE status = 'held'",
        )
        .all()
        .map((r) => r.node_id)
    },
    markSent(ids, now) {
      for (const id of ids)
        sqlite
          .query("UPDATE ch_proactive SET status = 'sent', sent_at = ? WHERE id = ?")
          .run(now, id)
    },
    recordSent(input, now) {
      sqlite
        .query(
          `INSERT INTO ch_proactive (id, connection_id, node_id, agent_id, body, mentions, status, created_at, sent_at)
           VALUES (?, ?, ?, ?, '', ?, 'sent', ?, ?)`,
        )
        .run(
          uuidv7(),
          input.connectionId,
          input.nodeId,
          input.agentId,
          JSON.stringify(input.mentions),
          now,
          now,
        )
    },
    lastSentAt(nodeId) {
      const r = sqlite
        .query<{ at: number | null }, [string]>(
          "SELECT MAX(sent_at) AS at FROM ch_proactive WHERE node_id = ? AND status = 'sent'",
        )
        .get(nodeId)
      return r?.at ?? undefined
    },
    sentSince(nodeId, since) {
      return (
        sqlite
          .query<{ n: number }, [string, number]>(
            "SELECT COUNT(*) AS n FROM ch_proactive WHERE node_id = ? AND status = 'sent' AND sent_at >= ?",
          )
          .get(nodeId, since)?.n ?? 0
      )
    },
    purge(before) {
      return sqlite
        .query("DELETE FROM ch_proactive WHERE status != 'held' AND created_at < ?")
        .run(before).changes
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM ch_proactive WHERE connection_id = ?').run(connectionId)
    },
  }
}
