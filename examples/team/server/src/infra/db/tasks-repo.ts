/**
 * Task index on SQLite (and the read side of the app's feed: sidebar previews and unread counts) (plain SQL on the shared connection, like the eharness
 * adapters). The `taskIndex` plugin writes through the write half on whichever instance runs a
 * turn; every instance reads the same rows. Every statement is atomic, increments are done in
 * SQL (`cost_usd = cost_usd + ?`), so two instances never lose an update.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { AgentActivity, TaskStore } from '../../app/ports.ts'
import { parseDeliverableResult } from '../../domain/deliverables.ts'
import { parseReport } from '../../domain/programs.ts'
import type {
  PendingKind,
  Task,
  TaskOrigin,
  TaskPriority,
  TaskReport,
  TaskStatus,
} from '../../domain/tasks.ts'
import {
  briefWithFeedback,
  isQueuedSession,
  PRIORITY_RANK,
  queuedSessionId,
} from '../../domain/work-queue.ts'

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
  report: string | null
  deliverables: string | null
  brief: string | null
  inputs: string
  priority: string
  due_at: number | null
  created_by: string | null
  accepted_at: number | null
  round: number
  history: string
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const strings = (text: string): string[] => {
  const v = parseJson(text)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
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
  report: parseReport(parseJson(r.report)) ?? null,
  deliverables: parseDeliverableResult(parseJson(r.deliverables)) ?? null,
  brief: r.brief,
  inputs: strings(r.inputs),
  priority: r.priority as TaskPriority,
  dueAt: r.due_at,
  createdBy: r.created_by,
  acceptedAt: r.accepted_at,
  round: r.round,
  history: strings(r.history),
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
  /** The structured report of a program run (kept when absent). */
  report?: TaskReport | null
}

/** The write half, used by the `taskIndex` plugin and the drift pass. */
export interface TaskWriter {
  /** Insert the row of a task session when absent; returns the stored row either way. */
  ensure(task: NewTask): Task
  /** Set status and counters; `undefined` when the session has no row. */
  update(sessionId: string, update: TaskUpdate): Task | undefined
  getBySession(sessionId: string): Task | undefined
  /** Tasks that have a session and are not finished (the drift pass re-reads them). */
  active(): Task[]
}

/** The queue order: priority, then the nearest due date, then the oldest (ids sort by creation). */
const QUEUE_ORDER = `CASE priority ${Object.entries(PRIORITY_RANK)
  .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
  .join(' ')} ELSE 1 END DESC, due_at IS NULL, due_at, id`

export type SqliteTaskStore = TaskStore & TaskWriter

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

    ofProgram(programId, limit) {
      return sqlite
        .query<TaskRow, [string, number]>(
          // session ids are `program:<id>:<runAt>`; the id has no `%` or `_` of its own (UUID).
          // A task sent back waits `queued` and is not a run until a worker takes it again.
          "SELECT * FROM tasks WHERE session_id LIKE 'program:' || ? || ':%' AND state != 'queued' ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .all(programId, limit)
        .map(toTask)
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
          uuidv7(),
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
                  summary = COALESCE(?, summary), cost_usd = cost_usd + ?, tokens = tokens + ?,
                  report = COALESCE(?, report)
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
          u.report == null ? null : JSON.stringify(u.report),
          sessionId,
        )
      const row = taskBySession.get(sessionId)
      return row === null ? undefined : toTask(row)
    },

    enqueue(t) {
      const id = uuidv7()
      sqlite
        .query(
          `INSERT INTO tasks (id, agent_id, session_id, parent_session_id, origin, title, state, pending_kind,
                              started_at, ended_at, summary, last_activity_at, cost_usd, tokens,
                              brief, inputs, priority, due_at, created_by, round, history)
           VALUES (?, ?, ?, NULL, 'program', ?, 'queued', NULL, ?, NULL, NULL, ?, 0, 0, ?, ?, ?, ?, ?, 1, '[]')`,
        )
        .run(
          id,
          t.agentId,
          queuedSessionId(id),
          t.title,
          t.now,
          t.now,
          t.brief,
          JSON.stringify(t.inputs),
          t.priority,
          t.dueAt,
          t.createdBy,
        )
      return toTask(taskById.get(id) as TaskRow)
    },

    patchQueued(id, p, now) {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      const set = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (p.agentId !== undefined) set('agent_id', p.agentId)
      if (p.title !== undefined) set('title', p.title)
      if (p.brief !== undefined) set('brief', p.brief)
      if (p.inputs !== undefined) set('inputs', JSON.stringify(p.inputs))
      if (p.priority !== undefined) set('priority', p.priority)
      if (p.dueAt !== undefined) set('due_at', p.dueAt)
      set('last_activity_at', now)
      const res = sqlite
        .query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND state = 'queued'`)
        .run(...params, id)
      return res.changes === 0 ? undefined : toTask(taskById.get(id) as TaskRow)
    },

    cancelQueued(id, now) {
      const res = sqlite
        .query(
          `UPDATE tasks SET state = 'stopped', summary = 'Cancelled before it started',
                  ended_at = ?, last_activity_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(now, now, id)
      return res.changes === 0 ? undefined : toTask(taskById.get(id) as TaskRow)
    },

    claimNext(agentId, sessionId, now) {
      return sqlite
        .transaction((): Task | undefined => {
          const row = sqlite
            .query<TaskRow, [string]>(
              `SELECT * FROM tasks WHERE state = 'queued' AND agent_id = ? ORDER BY ${QUEUE_ORDER} LIMIT 1`,
            )
            .get(agentId)
          if (row === null) return undefined
          const history = isQueuedSession(row.session_id)
            ? strings(row.history)
            : [...strings(row.history), row.session_id]
          const res = sqlite
            .query(
              `UPDATE tasks SET state = 'running', session_id = ?, history = ?, started_at = ?,
                      ended_at = NULL, last_activity_at = ?, summary = NULL, report = NULL,
                      deliverables = NULL, pending_kind = NULL, accepted_at = NULL
                WHERE id = ? AND state = 'queued'`,
            )
            .run(sessionId, JSON.stringify(history), now, now, row.id)
          return res.changes === 0 ? undefined : toTask(taskById.get(row.id) as TaskRow)
        })
        .immediate()
    },

    accept(id, now) {
      const row = taskById.get(id)
      if (row === null) return undefined
      const res = sqlite
        .query(
          `UPDATE tasks SET accepted_at = ?, last_activity_at = ?
            WHERE id = ? AND state = 'done' AND created_by IS NOT NULL AND accepted_at IS NULL`,
        )
        .run(now, now, id)
      return res.changes === 0 ? undefined : toTask(taskById.get(id) as TaskRow)
    },

    sendBack(id, note, now) {
      return sqlite
        .transaction((): Task | undefined => {
          const row = taskById.get(id)
          if (row === null) return undefined
          const task = toTask(row)
          // finished work waiting for review, or a work item that ended without finishing (try again)
          const retry = ['failed', 'stopped', 'interrupted', 'timed_out'].includes(task.status)
          const review = task.status === 'done' && task.acceptedAt === null
          if (task.createdBy === null || !(review || retry)) return undefined
          const round = task.round + 1
          const res = sqlite
            .query(
              `UPDATE tasks SET state = 'queued', brief = ?, round = ?, report = NULL, deliverables = NULL, summary = NULL,
                      ended_at = NULL, pending_kind = NULL, last_activity_at = ?
                WHERE id = ? AND state = ? AND accepted_at IS NULL`,
            )
            .run(briefWithFeedback(task.brief, round, note), round, now, id, task.status)
          return res.changes === 0 ? undefined : toTask(taskById.get(id) as TaskRow)
        })
        .immediate()
    },

    queued(agentId) {
      return sqlite
        .query<TaskRow, [string]>(
          `SELECT * FROM tasks WHERE state = 'queued' AND agent_id = ? ORDER BY ${QUEUE_ORDER}`,
        )
        .all(agentId)
        .map(toTask)
    },

    complete(sessionId, report, now) {
      const res = sqlite
        .query(
          `UPDATE tasks SET report = ?, summary = ?, last_activity_at = ?
            WHERE session_id = ? AND created_by IS NOT NULL AND state IN ('running', 'needs_action')`,
        )
        .run(JSON.stringify(report), report.summary.slice(0, 500), now, sessionId)
      if (res.changes === 0) return undefined
      const row = taskBySession.get(sessionId)
      return row === null ? undefined : toTask(row)
    },

    recordDeliverables(sessionId, result, override, now) {
      sqlite
        .query(
          `UPDATE tasks SET deliverables = ?, last_activity_at = ?,
                  report = COALESCE(?, report), summary = COALESCE(?, summary)
            WHERE session_id = ?`,
        )
        .run(
          JSON.stringify(result),
          now,
          override === null ? null : JSON.stringify(override.report),
          override === null ? null : override.summary,
          sessionId,
        )
      const row = taskBySession.get(sessionId)
      return row === null ? undefined : toTask(row)
    },

    active() {
      return sqlite
        .query<TaskRow, []>(
          "SELECT * FROM tasks WHERE state IN ('needs_action', 'running') AND session_id NOT LIKE 'queued:%' ORDER BY started_at",
        )
        .all()
        .map(toTask)
    },
  }
}
