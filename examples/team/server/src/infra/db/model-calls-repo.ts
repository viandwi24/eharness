/**
 * Model call log on SQLite (plain SQL on the shared connection). The `activityLog` plugin writes
 * through the write half on whichever instance made the call; every instance reads the same rows.
 * Rows sort by `(started_at, id)`, newest first; a cursor is `<started_at>:<id>`.
 */
import type { Database } from 'bun:sqlite'
import type { ModelCallStore } from '../../app/ports.ts'
import {
  bucketWidth,
  capJson,
  DEFAULT_JSON_CAP,
  MAX_BUCKETS,
  type ModelCallBucket,
  type ModelCallDetail,
  type ModelCallFilter,
  type ModelCallKind,
  type ModelCallStatus,
  type ModelCallSummary,
  type NewModelCall,
} from '../../domain/model-calls.ts'

interface Row {
  id: string
  created_at: number
  kind: string
  agent_id: string | null
  session_id: string | null
  turn_id: string | null
  step_index: number | null
  message_id: string | null
  task_id: string | null
  provider: string
  model_id: string
  status: string
  finish_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cached_tokens: number | null
  cost_usd: number | null
  started_at: number
  first_chunk_ms: number | null
  duration_ms: number
  error_name: string | null
  error_message: string | null
  truncated: number
}

interface DetailRow extends Row {
  request_options: string | null
  request_body: string | null
  response: string | null
  output: string | null
  provider_metadata: string | null
  usage_raw: string | null
}

const SUMMARY_COLUMNS =
  'id, created_at, kind, agent_id, session_id, turn_id, step_index, message_id, task_id, provider, model_id, status, finish_reason, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cost_usd, started_at, first_chunk_ms, duration_ms, error_name, error_message, truncated'

const toSummary = (r: Row): ModelCallSummary => ({
  id: r.id,
  createdAt: r.created_at,
  kind: r.kind as ModelCallKind,
  agentId: r.agent_id,
  sessionId: r.session_id,
  turnId: r.turn_id,
  stepIndex: r.step_index,
  messageId: r.message_id,
  taskId: r.task_id,
  provider: r.provider,
  modelId: r.model_id,
  status: r.status as ModelCallStatus,
  finishReason: r.finish_reason,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  reasoningTokens: r.reasoning_tokens,
  cachedTokens: r.cached_tokens,
  costUsd: r.cost_usd,
  startedAt: r.started_at,
  firstChunkMs: r.first_chunk_ms,
  durationMs: r.duration_ms,
  errorName: r.error_name,
  errorMessage: r.error_message,
  truncated: r.truncated !== 0,
})

const parse = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `%` and `_` in user text are literals. */
const like = (text: string): string => `%${text.replace(/[\\%_]/g, '\\$&')}%`

type Param = string | number

/** WHERE conditions of a filter (all optional, AND-ed). */
function conditions(f: ModelCallFilter): { where: string[]; params: Param[] } {
  const where: string[] = []
  const params: Param[] = []
  if (f.from !== undefined) {
    where.push('started_at >= ?')
    params.push(f.from)
  }
  if (f.to !== undefined) {
    where.push('started_at <= ?')
    params.push(f.to)
  }
  if (f.agentId !== undefined) {
    where.push('agent_id = ?')
    params.push(f.agentId)
  }
  if (f.sessionId !== undefined) {
    where.push('session_id = ?')
    params.push(f.sessionId)
  }
  if (f.kind !== undefined) {
    where.push('kind = ?')
    params.push(f.kind)
  }
  if (f.status !== undefined) {
    where.push('status = ?')
    params.push(f.status)
  }
  if (f.model !== undefined && f.model !== '') {
    where.push("model_id LIKE ? ESCAPE '\\'")
    params.push(like(f.model))
  }
  if (f.q !== undefined && f.q !== '') {
    where.push(
      "(model_id LIKE ? ESCAPE '\\' OR provider LIKE ? ESCAPE '\\' OR agent_id IN (SELECT id FROM agents WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\'))",
    )
    const p = like(f.q)
    params.push(p, p, p, p)
  }
  return { where, params }
}

const clause = (where: string[]): string => (where.length > 0 ? `WHERE ${where.join(' AND ')}` : '')

export interface ModelCallWriter {
  insert(call: NewModelCall, now: number): void
  /**
   * Delete rows older than `olderThan` (by `created_at`), then the oldest rows beyond `maxRows`.
   * Returns how many were deleted.
   */
  prune(options: { maxRows: number; olderThan: number }): number
  count(): number
}

export interface ModelCallRepoOptions {
  /** Cap of each JSON column in characters (default 512 KB). */
  jsonCap?: number
}

export type SqliteModelCallStore = ModelCallStore & ModelCallWriter

export function sqliteModelCallStore(
  sqlite: Database,
  options: ModelCallRepoOptions = {},
): SqliteModelCallStore {
  const cap = options.jsonCap ?? DEFAULT_JSON_CAP

  const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
    const i = cursor.indexOf(':')
    const at = Number(cursor.slice(0, i))
    return i > 0 && Number.isFinite(at) ? { at, id: cursor.slice(i + 1) } : undefined
  }

  return {
    insert(call, now) {
      const columns = [
        capJson(call.requestOptions, cap),
        capJson(call.requestBody, cap),
        capJson(call.response, cap),
        capJson(call.output, cap),
        capJson(call.providerMetadata, cap),
        capJson(call.usageRaw, cap),
      ]
      const truncated = columns.some((c) => c.truncated) ? 1 : 0
      sqlite
        .query(
          `INSERT OR IGNORE INTO model_calls (id, created_at, kind, agent_id, session_id, turn_id, step_index, message_id, task_id, provider, model_id, status, finish_reason, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cost_usd, started_at, first_chunk_ms, duration_ms, error_name, error_message, request_options, request_body, response, output, provider_metadata, usage_raw, truncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          call.id,
          now,
          call.kind,
          call.agentId,
          call.sessionId,
          call.turnId,
          call.stepIndex,
          call.messageId,
          call.taskId,
          call.provider,
          call.modelId,
          call.status,
          call.finishReason,
          call.inputTokens,
          call.outputTokens,
          call.reasoningTokens,
          call.cachedTokens,
          call.costUsd,
          call.startedAt,
          call.firstChunkMs,
          call.durationMs,
          call.errorName,
          call.errorMessage,
          ...columns.map((c) => c.text),
          truncated,
        )
    },

    prune({ maxRows, olderThan }) {
      let deleted = sqlite
        .query('DELETE FROM model_calls WHERE created_at < ?')
        .run(olderThan).changes
      const total = this.count()
      if (total > maxRows) {
        deleted += sqlite
          .query(
            'DELETE FROM model_calls WHERE id IN (SELECT id FROM model_calls ORDER BY started_at ASC, id ASC LIMIT ?)',
          )
          .run(total - maxRows).changes
      }
      return deleted
    },

    count() {
      return sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM model_calls').get()?.n ?? 0
    },

    list(query) {
      const { where, params } = conditions(query)
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
      if (cursor !== undefined) {
        where.push('(started_at < ? OR (started_at = ? AND id < ?))')
        params.push(cursor.at, cursor.at, cursor.id)
      }
      const rows = sqlite
        .query<Row, Param[]>(
          `SELECT ${SUMMARY_COLUMNS} FROM model_calls ${clause(where)} ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, query.limit + 1)
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      return {
        items: page.map(toSummary),
        nextCursor:
          rows.length > query.limit && last !== undefined ? `${last.started_at}:${last.id}` : null,
      }
    },

    get(id, filter): ModelCallDetail | undefined {
      const row = sqlite
        .query<DetailRow, [string]>('SELECT * FROM model_calls WHERE id = ?')
        .get(id)
      if (row === null) return undefined
      const neighbour = (older: boolean): string | null => {
        const { where, params } = conditions(filter)
        where.push(
          older
            ? '(started_at < ? OR (started_at = ? AND id < ?))'
            : '(started_at > ? OR (started_at = ? AND id > ?))',
        )
        params.push(row.started_at, row.started_at, row.id)
        const hit = sqlite
          .query<{ id: string }, Param[]>(
            `SELECT id FROM model_calls ${clause(where)} ORDER BY started_at ${older ? 'DESC' : 'ASC'}, id ${older ? 'DESC' : 'ASC'} LIMIT 1`,
          )
          .get(...params)
        return hit?.id ?? null
      }
      return {
        ...toSummary(row),
        requestOptions: parse(row.request_options),
        requestBody: parse(row.request_body),
        response: parse(row.response),
        output: parse(row.output),
        providerMetadata: parse(row.provider_metadata),
        usageRaw: parse(row.usage_raw),
        prevId: neighbour(false),
        nextId: neighbour(true),
      }
    },

    usage(filter = {}) {
      const where: string[] = []
      const params: Param[] = []
      if (filter.from !== undefined) {
        where.push('m.started_at >= ?')
        params.push(filter.from)
      }
      if (filter.to !== undefined) {
        where.push('m.started_at <= ?')
        params.push(filter.to)
      }
      const rows = sqlite
        .query<
          {
            agent_id: string | null
            source: string
            calls: number
            turns: number
            sessions: number
            tokens: number
            cost: number
          },
          Param[]
        >(
          `SELECT m.agent_id AS agent_id,
             CASE WHEN m.session_id IS NULL THEN 'other'
                  WHEN m.session_id LIKE 'heartbeat:%' THEN 'heartbeat'
                  WHEN m.session_id LIKE 'rehearsal:%' THEN 'rehearsal'
                  WHEN m.session_id LIKE 'program:%' THEN 'program'
                  WHEN m.session_id LIKE 'routine:%' THEN 'routine'
                  WHEN t.origin = 'user' THEN 'task'
                  WHEN t.origin = 'lead' OR m.session_id LIKE '%:agent:%' THEN 'delegated'
                  ELSE 'chat' END AS source,
             COUNT(*) AS calls,
             COUNT(DISTINCT m.session_id || '|' || COALESCE(m.turn_id, '')) AS turns,
             COUNT(DISTINCT m.session_id) AS sessions,
             COALESCE(SUM(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)), 0) AS tokens,
             COALESCE(SUM(m.cost_usd), 0) AS cost
           FROM model_calls m LEFT JOIN tasks t ON t.session_id = m.session_id
           ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           GROUP BY m.agent_id, source`,
        )
        .all(...params)
      const first = sqlite
        .query<{ at: number | null }, []>('SELECT MIN(started_at) AS at FROM model_calls')
        .get()
      return {
        since: first?.at ?? null,
        rows: rows.map((r) => ({
          agentId: r.agent_id,
          source: r.source,
          calls: r.calls,
          turns: r.turns,
          sessions: r.sessions,
          tokens: r.tokens,
          costUsd: r.cost,
        })),
      }
    },

    stats(query) {
      const { from, to } = query
      const bucketMs = query.bucketMs ?? bucketWidth(to - from)
      const width = Math.max(bucketMs, Math.ceil((to - from) / MAX_BUCKETS), 1)
      const { where, params } = conditions(query)
      const rows = sqlite
        .query<
          {
            b: number
            n: number
            errors: number
            input: number
            output: number
            cost: number
          },
          Param[]
        >(
          `SELECT CAST((started_at - ?) / ? AS INTEGER) AS b, COUNT(*) AS n,
                  SUM(status = 'error') AS errors,
                  COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cost_usd), 0) AS cost
           FROM model_calls ${clause(where)} GROUP BY b`,
        )
        .all(from, width, ...params)
      const count = Math.max(1, Math.ceil((to - from + 1) / width))
      const buckets: ModelCallBucket[] = Array.from({ length: count }, (_, i) => ({
        start: from + i * width,
        count: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }))
      const totals = {
        count: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        aborted: 0,
      }
      for (const r of rows) {
        const bucket = buckets[Math.min(Math.max(r.b, 0), count - 1)]
        if (bucket === undefined) continue
        bucket.count += r.n
        bucket.errors += r.errors
        bucket.inputTokens += r.input
        bucket.outputTokens += r.output
        bucket.costUsd += r.cost
        totals.count += r.n
        totals.errors += r.errors
        totals.inputTokens += r.input
        totals.outputTokens += r.output
        totals.costUsd += r.cost
      }
      const abortedFilter = conditions(query)
      abortedFilter.where.push("status = 'aborted'")
      totals.aborted =
        sqlite
          .query<{ n: number }, Param[]>(
            `SELECT COUNT(*) AS n FROM model_calls ${clause(abortedFilter.where)}`,
          )
          .get(...abortedFilter.params)?.n ?? 0
      const { model: _model, ...rest } = query
      const others = conditions(rest)
      const models = sqlite
        .query<{ model_id: string }, Param[]>(
          `SELECT model_id FROM model_calls ${clause(others.where)} GROUP BY model_id ORDER BY COUNT(*) DESC, model_id LIMIT 50`,
        )
        .all(...others.params)
        .map((r) => r.model_id)
      return { from, to, bucketMs: width, buckets, totals, models }
    },
  }
}
