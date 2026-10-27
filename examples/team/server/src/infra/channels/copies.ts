/**
 * The copy map of agents (`channel_copy`): which message was copied where. Replies follow a copy
 * (the reply goes under the copy of the message it answers), and edits and deletions of a source
 * reach its copies (`sync`). A trial row records where an agent would have copied a message while
 * its source chat is in trial mode; nothing was sent.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'

export interface CopyRow {
  id: string
  connectionId: string
  sourceNode: string
  sourceId: string
  targetNode: string
  /** Null for a trial row. */
  targetId: string | null
  trial: boolean
  sync: boolean
  ownCaption: boolean
  agentId: string | null
  note: string | null
  createdAt: number
}

export interface NewCopy {
  connectionId: string
  sourceNode: string
  sourceId: string
  targetNode: string
  targetId: string | null
  trial?: boolean
  sync?: boolean
  ownCaption?: boolean
  agentId?: string | undefined
  note?: string | undefined
}

export interface CopyStore {
  add(rows: readonly NewCopy[], now: number): void
  /** The copies of a source message (trial rows too), oldest first. */
  of(sourceNode: string, sourceId: string): CopyRow[]
  /** The row of a copy (by where it sits), or undefined. */
  sourceOf(targetNode: string, targetId: string): CopyRow | undefined
  /** Recent rows of a source chat (newest first): what an agent copied, or would have. */
  recent(sourceNode: string, limit: number): CopyRow[]
  /** Removes rows older than `olderThan`. */
  prune(olderThan: number): number
}

interface Db {
  id: string
  connection_id: string
  source_node: string
  source_id: string
  target_node: string
  target_id: string | null
  trial: number
  sync: number
  own_caption: number
  agent_id: string | null
  note: string | null
  created_at: number
}

const rowOf = (r: Db): CopyRow => ({
  id: r.id,
  connectionId: r.connection_id,
  sourceNode: r.source_node,
  sourceId: r.source_id,
  targetNode: r.target_node,
  targetId: r.target_id,
  trial: r.trial === 1,
  sync: r.sync === 1,
  ownCaption: r.own_caption === 1,
  agentId: r.agent_id,
  note: r.note,
  createdAt: r.created_at,
})

export function sqliteCopyStore(sqlite: Database): CopyStore {
  const insert = sqlite.query(
    `INSERT INTO ch_copies (id, connection_id, source_node, source_id, target_node, target_id, trial, sync,
       own_caption, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  return {
    add(rows, now) {
      sqlite.transaction(() => {
        for (const r of rows)
          insert.run(
            uuidv7(),
            r.connectionId,
            r.sourceNode,
            r.sourceId,
            r.targetNode,
            r.targetId,
            r.trial === true ? 1 : 0,
            r.sync === false ? 0 : 1,
            r.ownCaption === true ? 1 : 0,
            r.agentId ?? null,
            r.note === undefined ? null : r.note.slice(0, 500),
            now,
          )
      })()
    },
    of(sourceNode, sourceId) {
      return sqlite
        .query<Db, [string, string]>(
          'SELECT * FROM ch_copies WHERE source_node = ? AND source_id = ? ORDER BY id LIMIT 100',
        )
        .all(sourceNode, sourceId)
        .map(rowOf)
    },
    sourceOf(targetNode, targetId) {
      const r = sqlite
        .query<Db, [string, string]>(
          'SELECT * FROM ch_copies WHERE target_node = ? AND target_id = ? ORDER BY id LIMIT 1',
        )
        .get(targetNode, targetId)
      return r === null ? undefined : rowOf(r)
    },
    recent(sourceNode, limit) {
      return sqlite
        .query<Db, [string, number]>(
          'SELECT * FROM ch_copies WHERE source_node = ? ORDER BY id DESC LIMIT ?',
        )
        .all(sourceNode, limit)
        .map(rowOf)
    },
    prune(olderThan) {
      return sqlite.query('DELETE FROM ch_copies WHERE created_at < ?').run(olderThan).changes
    },
  }
}
