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
  type ModelCallBreakdownRow,
  type ModelCallBucket,
  type ModelCallDetail,
  type ModelCallFilter,
  type ModelCallKind,
  type ModelCallStatus,
  type ModelCallSummary,
  type ModelCallTotals,
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

/**
 * Source of a call (see `MODEL_CALL_SOURCES`). Uses the task of the session as a scalar subquery
 * (`tasks.session_id` is unique) so it works in any query on `model_calls` without a join.
 */
const SOURCE_SQL = `CASE
  WHEN kind = 'compaction' THEN 'compaction'
  WHEN kind = 'flush' THEN 'flush'
  WHEN kind = 'other' THEN 'classifier'
  WHEN session_id IS NULL THEN 'other'
  WHEN session_id LIKE 'heartbeat:%' THEN 'heartbeat'
  WHEN session_id LIKE 'program:%' OR session_id LIKE 'rehearsal:%' THEN 'program'
  WHEN session_id LIKE 'routine:%' THEN 'routine'
  WHEN session_id LIKE 'api:%' THEN 'api'
  WHEN (SELECT origin FROM tasks WHERE tasks.session_id = model_calls.session_id) = 'user' THEN 'task'
  WHEN (SELECT origin FROM tasks WHERE tasks.session_id = model_calls.session_id) = 'lead'
    OR session_id LIKE '%:agent:%' OR session_id LIKE '%:worker:%' THEN 'delegated'
  ELSE 'chat' END`

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
  if (f.source !== undefined) {
    where.push(`(${SOURCE_SQL}) = ?`)
    params.push(f.source)
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
  /**
   * Removes rows older than `olderThan` or beyond `maxRows`, and empties the request, response and
   * output of rows older than `bodiesOlderThan` (their metadata stays: tokens, cost, timing).
   */
  prune(options: { maxRows: number; olderThan: number; bodiesOlderThan?: number }): number
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

    prune({ maxRows, olderThan, bodiesOlderThan }) {
      if (bodiesOlderThan !== undefined) {
        sqlite
          .query(
            `UPDATE model_calls SET request_options = NULL, request_body = NULL, response = NULL,
               output = NULL, provider_metadata = NULL
             WHERE created_at < ? AND (request_body IS NOT NULL OR response IS NOT NULL OR output IS NOT NULL)`,
          )
          .run(bodiesOlderThan)
      }
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
                  WHEN t.origin = 'lead' OR m.session_id LIKE '%:agent:%' OR m.session_id LIKE '%:worker:%' THEN 'delegated'
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

      /** Totals and latency percentiles of `lo..hi` under the filters. */
      const totalsOf = (lo: number, hi: number): ModelCallTotals => {
        const c = conditions({ ...query, from: lo, to: hi })
        const t = sqlite
          .query<Omit<ModelCallTotals, 'p50Ms' | 'p95Ms'> & { timed: number }, Param[]>(
            `SELECT COUNT(*) AS count, COALESCE(SUM(status = 'error'), 0) AS errors,
                    COALESCE(SUM(status = 'aborted'), 0) AS aborted,
                    COALESCE(SUM(input_tokens), 0) AS inputTokens,
                    COALESCE(SUM(output_tokens), 0) AS outputTokens,
                    COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
                    COALESCE(SUM(cost_usd), 0) AS costUsd,
                    COALESCE(SUM(status != 'aborted'), 0) AS timed
             FROM model_calls ${clause(c.where)}`,
          )
          .get(...c.params)
        const { timed = 0, ...totals } = t ?? {
          count: 0,
          errors: 0,
          aborted: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          costUsd: 0,
          timed: 0,
        }
        // nearest-rank percentile: the row at that offset of the sorted durations
        const at = (p: number): number | null => {
          if (timed === 0) return null
          const w = [...c.where, "status != 'aborted'"]
          return (
            sqlite
              .query<{ d: number }, Param[]>(
                `SELECT duration_ms AS d FROM model_calls ${clause(w)} ORDER BY duration_ms LIMIT 1 OFFSET ?`,
              )
              .get(...c.params, Math.max(0, Math.ceil(p * timed) - 1))?.d ?? null
          )
        }
        return { ...totals, p50Ms: at(0.5), p95Ms: at(0.95) }
      }

      const rows = sqlite
        .query<
          {
            b: number
            source: string
            agent_id: string | null
            status: string
            n: number
            input: number
            output: number
            cached: number
            reasoning: number
            cost: number
            ms: number
          },
          Param[]
        >(
          `SELECT CAST((started_at - ?) / ? AS INTEGER) AS b, ${SOURCE_SQL} AS source, agent_id, status,
                  COUNT(*) AS n,
                  COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cached_tokens), 0) AS cached, COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
                  COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS ms
           FROM model_calls ${clause(where)} GROUP BY b, source, agent_id, status`,
        )
        .all(from, width, ...params)
      const count = Math.max(1, Math.ceil((to - from + 1) / width))
      const buckets: ModelCallBucket[] = Array.from({ length: count }, (_, i) => ({
        start: from + i * width,
        count: 0,
        errors: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        costBySource: {},
        costByAgent: {},
      }))
      const agents = new Map<string, ModelCallBreakdownRow>()
      for (const r of rows) {
        const bucket = buckets[Math.min(Math.max(r.b, 0), count - 1)]
        if (bucket === undefined) continue
        bucket.count += r.n
        if (r.status === 'error') bucket.errors += r.n
        if (r.status === 'aborted') bucket.aborted += r.n
        bucket.inputTokens += r.input
        bucket.outputTokens += r.output
        bucket.cachedTokens += r.cached
        bucket.reasoningTokens += r.reasoning
        bucket.costUsd += r.cost
        if (r.cost > 0) {
          bucket.costBySource[r.source] = (bucket.costBySource[r.source] ?? 0) + r.cost
          const agentKey = r.agent_id ?? 'none'
          bucket.costByAgent[agentKey] = (bucket.costByAgent[agentKey] ?? 0) + r.cost
        }
        const row = agents.get(r.agent_id ?? '') ?? {
          key: r.agent_id,
          calls: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          avgDurationMs: 0, // holds the duration sum until the end
        }
        row.calls += r.n
        if (r.status === 'error') row.errors += r.n
        row.inputTokens += r.input
        row.outputTokens += r.output
        row.costUsd += r.cost
        row.avgDurationMs += r.ms
        agents.set(r.agent_id ?? '', row)
      }
      const byCost = (a: ModelCallBreakdownRow, b: ModelCallBreakdownRow): number =>
        b.costUsd - a.costUsd || b.calls - a.calls
      const byAgent = [...agents.values()]
        .map((r) => ({ ...r, avgDurationMs: r.calls > 0 ? r.avgDurationMs / r.calls : 0 }))
        .sort(byCost)
      const byModel = sqlite
        .query<ModelCallBreakdownRow, Param[]>(
          `SELECT model_id AS key, COUNT(*) AS calls, COALESCE(SUM(status = 'error'), 0) AS errors,
                  COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
                  COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(AVG(duration_ms), 0) AS avgDurationMs
           FROM model_calls ${clause(where)} GROUP BY model_id`,
        )
        .all(...params)
        .sort(byCost)
      const { model: _model, ...rest } = query
      const others = conditions(rest)
      const models = sqlite
        .query<{ model_id: string }, Param[]>(
          `SELECT model_id FROM model_calls ${clause(others.where)} GROUP BY model_id ORDER BY COUNT(*) DESC, model_id LIMIT 50`,
        )
        .all(...others.params)
        .map((r) => r.model_id)
      const length = to - from + 1
      return {
        from,
        to,
        bucketMs: width,
        buckets,
        totals: totalsOf(from, to),
        previous: totalsOf(from - length, from - 1),
        byModel,
        byAgent,
        models,
      }
    },
  }
}
