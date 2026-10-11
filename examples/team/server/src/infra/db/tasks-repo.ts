/**
 * Task index and event feed on SQLite (plain SQL on the shared connection, like the eharness
 * adapters). The `taskIndex` plugin writes through the write half on whichever instance runs a
 * turn; every instance reads the same rows. Every statement is atomic, increments are done in
 * SQL (`cost_usd = cost_usd + ?`), so two instances never lose an update.
 */
import type { Database } from 'bun:sqlite'
import type { AgentActivity, TaskStore } from '../../app/ports.ts'
import type { EventType, NewEvent, TeamEvent } from '../../domain/events.ts'
import { newId } from '../../domain/ids.ts'
import type { PendingKind, Task, TaskOrigin, TaskStatus } from '../../domain/tasks.ts'

interface TaskRow {
  id: string
  agent_id: string
  session_id: string
  parent_session_id: string | null
  origin: string
  title: string
  state: string
  pending_kind: string | null
  started_at: number
  ended_at: number | null
  summary: string | null
  last_activity_at: number
  cost_usd: number
  tokens: number
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  agentId: r.agent_id,
  sessionId: r.session_id,
  parentSessionId: r.parent_session_id,
  origin: r.origin as TaskOrigin,
  title: r.title,
  status: r.state as TaskStatus,
  pendingKind: r.pending_kind as PendingKind | null,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary,
  lastActivityAt: r.last_activity_at,
  costUsd: r.cost_usd,
  tokens: r.tokens,
})

interface EventRow {
  seq: number
  type: string
  agent_id: string | null
  session_id: string | null
  payload: string
  created_at: number
}

const toEvent = (r: EventRow): TeamEvent => ({
  seq: r.seq,
  type: r.type as EventType,
  agentId: r.agent_id,
  sessionId: r.session_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  createdAt: r.created_at,
})

export interface NewTask {
  agentId: string
  sessionId: string
  parentSessionId: string | null
  origin: TaskOrigin
  title: string
  startedAt: number
}

export interface TaskUpdate {
  status: TaskStatus
  pendingKind: PendingKind | null
  now: number
  summary?: string | null
  addCostUsd?: number
  addTokens?: number
}

/** The write half, used by the `taskIndex` plugin and the drift pass. */
export interface TaskWriter {
  /** Insert the row of a task session when absent; returns the stored row either way. */
  ensure(task: NewTask): Task
  /** Set status and counters; `undefined` when the session has no row. */
  update(sessionId: string, update: TaskUpdate): Task | undefined
  getBySession(sessionId: string): Task | undefined
  /** Tasks that are not finished (the drift pass re-reads them). */
  active(): Task[]
  appendEvent(event: NewEvent, now: number): number
  /**
   * Event retention: delete events older than `before` (ms) and, when more than `maxRows` remain,
   * the oldest ones. Keeps the newest event (the head the cursors compare to) and the latest
   * `message-added` of every agent (the sidebar preview). Records the high-water mark
   * (`prunedThrough`). Safe to run from several instances. Returns the rows deleted.
   */
  pruneEvents(options: { before?: number; maxRows?: number }): number
}

export type SqliteTaskStore = TaskStore & TaskWriter

/** `settings` key holding the highest event `seq` removed by retention. */
const PRUNED_KEY = 'events-pruned-through'

export function sqliteTaskStore(sqlite: Database): SqliteTaskStore {
  const taskBySession = sqlite.query<TaskRow, [string]>('SELECT * FROM tasks WHERE session_id = ?')
  const taskById = sqlite.query<TaskRow, [string]>('SELECT * FROM tasks WHERE id = ?')

  return {
    list({ status, agentId, limit }) {
      const where: string[] = []
      const params: Array<string | number> = []
      if (status !== undefined) {
        where.push('state = ?')
        params.push(status)
      }
      if (agentId !== undefined) {
        where.push('agent_id = ?')
        params.push(agentId)
      }
      const sql = `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC, id DESC LIMIT ?`
      return sqlite
        .query<TaskRow, Array<string | number>>(sql)
        .all(...params, limit)
        .map(toTask)
    },

    get: (id) => {
      const row = taskById.get(id)
      return row === null ? undefined : toTask(row)
    },

    getBySession(sessionId) {
      const row = taskBySession.get(sessionId)
      return row === null ? undefined : toTask(row)
    },

    ofAgent(agentId, dmSessionId) {
      const owned = sqlite
        .query<TaskRow, [string]>(
          'SELECT * FROM tasks WHERE agent_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 200',
        )
        .all(agentId)
        .map(toTask)
      const delegated = sqlite
        .query<TaskRow, [string]>(
          'SELECT * FROM tasks WHERE parent_session_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 200',
        )
        .all(dmSessionId)
        .map(toTask)
      return { owned, delegated }
    },

    events(after, limit) {
      return sqlite
        .query<EventRow, [number, number]>(
          'SELECT seq, type, agent_id, session_id, payload, created_at FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
        )
        .all(after, limit)
        .map(toEvent)
    },

    lastSeq() {
      return (
        sqlite.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM events').get()?.seq ??
        0
      )
    },

    prunedThrough() {
      const row = sqlite
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
        .get(PRUNED_KEY)
      return row === null ? 0 : Number(JSON.parse(row.value))
    },

    pruneEvents({ before, maxRows }) {
      return sqlite
        .transaction(() => {
          const head =
            sqlite.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM events').get()
              ?.seq ?? 0
          let boundary = 0
          if (before !== undefined) {
            boundary =
              sqlite
                .query<{ seq: number | null }, [number]>(
                  'SELECT MAX(seq) AS seq FROM events WHERE created_at < ?',
                )
                .get(before)?.seq ?? 0
          }
          if (maxRows !== undefined && maxRows >= 1) {
            const cut = sqlite
              .query<{ seq: number }, [number]>(
                'SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?',
              )
              .get(maxRows)
            if (cut !== null) boundary = Math.max(boundary, cut.seq)
          }
          boundary = Math.min(boundary, head - 1)
          if (boundary <= 0) return 0
          const { changes } = sqlite
            .query(
              `DELETE FROM events WHERE seq <= ?
                 AND seq NOT IN (SELECT MAX(seq) FROM events
                                  WHERE type = 'message-added' AND agent_id IS NOT NULL
                                  GROUP BY agent_id)`,
            )
            .run(boundary)
          const known = sqlite
            .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
            .get(PRUNED_KEY)
          const next = Math.max(boundary, known === null ? 0 : Number(JSON.parse(known.value)))
          sqlite
            .query(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(PRUNED_KEY, JSON.stringify(next), Date.now())
          return changes
        })
        .immediate()
    },

    activity() {
      const out = new Map<string, AgentActivity>()
      const last = sqlite
        .query<{ agent_id: string; created_at: number; preview: string | null }, []>(
          `SELECT agent_id, created_at, json_extract(payload, '$.preview') AS preview
             FROM events
            WHERE seq IN (SELECT MAX(seq) FROM events WHERE type = 'message-added' AND agent_id IS NOT NULL GROUP BY agent_id)`,
        )
        .all()
      for (const row of last) {
        out.set(row.agent_id, { lastMessageAt: row.created_at, preview: row.preview, unread: 0 })
      }
      const unread = sqlite
        .query<{ agent_id: string; n: number }, []>(
          `SELECT e.agent_id AS agent_id, COUNT(*) AS n
             FROM events e LEFT JOIN chats c ON c.agent_id = e.agent_id
            WHERE e.type = 'message-added' AND json_extract(e.payload, '$.role') = 'assistant'
              AND e.seq > COALESCE(c.last_read_seq, 0)
            GROUP BY e.agent_id`,
        )
        .all()
      for (const row of unread) {
        const entry = out.get(row.agent_id)
        if (entry !== undefined) entry.unread = row.n
      }
      return out
    },

    markRead(agentId) {
      return sqlite
        .transaction(() => {
          const seq =
            sqlite.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM events').get()
              ?.seq ?? 0
          sqlite
            .query(
              `INSERT INTO chats (agent_id, session_id, unread, last_read_seq) VALUES (?, ?, 0, ?)
             ON CONFLICT(agent_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, unread = 0`,
            )
            .run(agentId, `dm:${agentId}`, seq)
          return seq
        })
        .immediate()
    },

    ensure(task) {
      sqlite
        .query(
          `INSERT INTO tasks (id, agent_id, session_id, parent_session_id, origin, title, state, pending_kind,
                              started_at, ended_at, summary, last_activity_at, cost_usd, tokens)
           VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL, NULL, ?, 0, 0)
           ON CONFLICT(session_id) DO NOTHING`,
        )
        .run(
          newId(task.startedAt),
          task.agentId,
          task.sessionId,
          task.parentSessionId,
          task.origin,
          task.title,
          task.startedAt,
          task.startedAt,
        )
      return toTask(taskBySession.get(task.sessionId) as TaskRow)
    },

    update(sessionId, u) {
      const finished =
        u.status === 'done' ||
        u.status === 'failed' ||
        u.status === 'stopped' ||
        u.status === 'interrupted'
      sqlite
        .query(
          `UPDATE tasks SET state = ?, pending_kind = ?, ended_at = ?, last_activity_at = ?,
                  summary = COALESCE(?, summary), cost_usd = cost_usd + ?, tokens = tokens + ?
            WHERE session_id = ?`,
        )
        .run(
          u.status,
          u.pendingKind,
          finished ? u.now : null,
          u.now,
          u.summary ?? null,
          u.addCostUsd ?? 0,
          u.addTokens ?? 0,
          sessionId,
        )
      const row = taskBySession.get(sessionId)
      return row === null ? undefined : toTask(row)
    },

    active() {
      return sqlite
        .query<TaskRow, []>(
          "SELECT * FROM tasks WHERE state IN ('needs_action', 'running') ORDER BY started_at",
        )
        .all()
        .map(toTask)
    },

    appendEvent(event, now) {
      const row = sqlite
        .query<{ seq: number }, [string, string | null, string | null, string, number]>(
          'INSERT INTO events (type, agent_id, session_id, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq',
        )
        .get(
          event.type,
          event.agentId ?? null,
          event.sessionId ?? null,
          JSON.stringify(event.payload),
          now,
        )
      return (row as { seq: number }).seq
    },
  }
}
