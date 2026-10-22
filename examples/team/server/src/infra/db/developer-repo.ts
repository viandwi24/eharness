/** SQLite stores of the Developer API (plain SQL on the shared connection; tables: `schema.ts`). */
import type { Database } from 'bun:sqlite'
import type {
  ApiAgentStore,
  ApiCallRecord,
  ApiConversationStore,
  ApiKeyStore,
  ApiUsageStore,
  UsageDay,
  UsageTotals,
} from '../../app/developer-api.ts'
import type {
  ApiAgent,
  ApiConversation,
  ApiKey,
  ApiMode,
  ApiRequestRow,
} from '../../domain/developer-api.ts'

type Row = Record<string, unknown>

const parse = <T>(text: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return fallback
  }
}

const agentOf = (r: Row): ApiAgent => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  description: r.description as string,
  instructions: r.instructions as string,
  rules: parse<string[]>(r.rules, []),
  model: (r.model as string | null) ?? null,
  modelProfile: (r.model_profile as string | null) ?? null,
  readFolders: parse<string[]>(r.read_folders, []),
  writeFolder: (r.write_folder as string | null) ?? null,
  webSearch: r.web_search === 1,
  retentionDays: r.retention_days as number,
  version: r.version as number,
  archivedAt: (r.archived_at as number | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
})

export function sqliteApiAgents(sqlite: Database): ApiAgentStore {
  const params = (a: ApiAgent): Array<string | number | null> => [
    a.slug,
    a.name,
    a.description,
    a.instructions,
    JSON.stringify(a.rules),
    a.model,
    a.modelProfile,
    JSON.stringify(a.readFolders),
    a.writeFolder,
    a.webSearch ? 1 : 0,
    a.retentionDays,
    a.version,
    a.archivedAt,
    a.updatedAt,
  ]
  return {
    list: (includeArchived) =>
      sqlite
        .query<Row, []>(
          `SELECT * FROM api_agents ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at, id`,
        )
        .all()
        .map(agentOf),
    get: (idOrSlug) => {
      const r = sqlite
        .query<Row, [string, string]>('SELECT * FROM api_agents WHERE id = ? OR slug = ?')
        .get(idOrSlug, idOrSlug)
      return r === null ? undefined : agentOf(r)
    },
    insert: (a) =>
      void sqlite
        .query(
          `INSERT INTO api_agents (id, created_at, slug, name, description, instructions, rules, model, model_profile,
             read_folders, write_folder, web_search, retention_days, version, archived_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(a.id, a.createdAt, ...params(a)),
    update: (a) =>
      void sqlite
        .query(
          `UPDATE api_agents SET slug = ?, name = ?, description = ?, instructions = ?, rules = ?, model = ?,
             model_profile = ?, read_folders = ?, write_folder = ?, web_search = ?, retention_days = ?, version = ?,
             archived_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...params(a), a.id),
  }
}

const keyOf = (r: Row): ApiKey => ({
  id: r.id as string,
  name: r.name as string,
  hash: r.hash as string,
  agents: parse<string[]>(r.agents, []),
  dailyCostLimitUsd: (r.daily_cost_limit_usd as number | null) ?? null,
  rateLimitPerMin: (r.rate_limit_per_min as number | null) ?? null,
  origins: parse<string[]>(r.origins, []),
  expiresAt: (r.expires_at as number | null) ?? null,
  revokedAt: (r.revoked_at as number | null) ?? null,
  lastUsedAt: (r.last_used_at as number | null) ?? null,
  createdAt: r.created_at as number,
})

export function sqliteApiKeys(sqlite: Database): ApiKeyStore {
  return {
    get: (id) => {
      const r = sqlite.query<Row, [string]>('SELECT * FROM api_keys WHERE id = ?').get(id)
      return r === null ? undefined : keyOf(r)
    },
    list: () =>
      sqlite.query<Row, []>('SELECT * FROM api_keys ORDER BY created_at DESC, id').all().map(keyOf),
    insert: (k) =>
      void sqlite
        .query(
          `INSERT INTO api_keys (id, name, hash, agents, daily_cost_limit_usd, rate_limit_per_min, origins,
             expires_at, revoked_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          k.id,
          k.name,
          k.hash,
          JSON.stringify(k.agents),
          k.dailyCostLimitUsd,
          k.rateLimitPerMin,
          JSON.stringify(k.origins),
          k.expiresAt,
          k.revokedAt,
          k.lastUsedAt,
          k.createdAt,
        ),
    update: (k) =>
      void sqlite
        .query(
          `UPDATE api_keys SET name = ?, agents = ?, daily_cost_limit_usd = ?, rate_limit_per_min = ?, origins = ?,
             expires_at = ?, revoked_at = ?, last_used_at = ? WHERE id = ?`,
        )
        .run(
          k.name,
          JSON.stringify(k.agents),
          k.dailyCostLimitUsd,
          k.rateLimitPerMin,
          JSON.stringify(k.origins),
          k.expiresAt,
          k.revokedAt,
          k.lastUsedAt,
          k.id,
        ),
    originKnown: (origin, now) =>
      sqlite
        .query<Row, [number]>(
          "SELECT origins FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND origins <> '[]'",
        )
        .all(now)
        .some((r) => parse<string[]>(r.origins, []).includes(origin)),
  }
}

const conversationOf = (r: Row): ApiConversation => ({
  id: r.id as string,
  agentId: r.agent_id as string,
  keyId: r.key_id as string,
  endUserId: (r.end_user_id as string | null) ?? null,
  metadata: parse<Record<string, unknown>>(r.metadata, {}),
  status: r.status === 'closed' ? 'closed' : 'open',
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  lastMessageAt: r.last_message_at as number,
})

export function sqliteApiConversations(sqlite: Database): ApiConversationStore {
  return {
    insert: (c) =>
      void sqlite
        .query(
          `INSERT INTO api_conversations (id, agent_id, key_id, end_user_id, metadata, status, created_at, updated_at, last_message_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id,
          c.agentId,
          c.keyId,
          c.endUserId,
          JSON.stringify(c.metadata),
          c.status,
          c.createdAt,
          c.updatedAt,
          c.lastMessageAt,
        ),
    get: (id) => {
      const r = sqlite.query<Row, [string]>('SELECT * FROM api_conversations WHERE id = ?').get(id)
      return r === null ? undefined : conversationOf(r)
    },
    findOpen: (agentId, keyId, endUserId) => {
      const r = sqlite
        .query<Row, [string, string, string]>(
          `SELECT * FROM api_conversations WHERE agent_id = ? AND key_id = ? AND end_user_id = ? AND status = 'open'
           ORDER BY last_message_at DESC LIMIT 1`,
        )
        .get(agentId, keyId, endUserId)
      return r === null ? undefined : conversationOf(r)
    },
    update: (c) =>
      void sqlite
        .query(
          'UPDATE api_conversations SET status = ?, metadata = ?, updated_at = ?, last_message_at = ? WHERE id = ?',
        )
        .run(c.status, JSON.stringify(c.metadata), c.updatedAt, c.lastMessageAt, c.id),
    idle: (agentId, before) =>
      sqlite
        .query<Row, [string, number]>(
          'SELECT * FROM api_conversations WHERE agent_id = ? AND last_message_at < ?',
        )
        .all(agentId, before)
        .map(conversationOf),
    delete: (id) => void sqlite.query('DELETE FROM api_conversations WHERE id = ?').run(id),
  }
}

const requestOf = (r: Row): ApiRequestRow => ({
  id: r.id as string,
  at: r.at as number,
  keyId: r.key_id as string,
  agentId: r.agent_id as string,
  mode: r.mode as ApiMode,
  conversationId: (r.conversation_id as string | null) ?? null,
  status: r.status as number,
  errorCode: (r.error_code as string | null) ?? null,
  inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number,
  costUsd: r.cost_usd as number,
  durationMs: r.duration_ms as number,
})

export function sqliteApiUsage(sqlite: Database): ApiUsageStore {
  const scalar = (sql: string, ...args: Array<string | number>): number =>
    sqlite.query<{ n: number | null }, Array<string | number>>(sql).get(...args)?.n ?? 0
  /** Requests that were turned away before they ran (auth, origin, limits) do not count as requests. */
  const ADMITTED = 'status NOT IN (401, 403, 429)'
  return {
    logRequest: (r) =>
      void sqlite
        .query(
          `INSERT INTO api_requests (id, at, key_id, agent_id, mode, conversation_id, status, error_code,
             input_tokens, output_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.at,
          r.keyId,
          r.agentId,
          r.mode,
          r.conversationId,
          r.status,
          r.errorCode,
          r.inputTokens,
          r.outputTokens,
          r.costUsd,
          r.durationMs,
        ),
    finishRequest: (id, p) =>
      void sqlite
        .query(
          `UPDATE api_requests SET status = ?, error_code = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
             duration_ms = ? WHERE id = ?`,
        )
        .run(p.status, p.errorCode, p.inputTokens, p.outputTokens, p.costUsd, p.durationMs, id),
    requests: (f) => {
      const where: string[] = []
      const args: Array<string | number> = []
      if (f.keyId !== undefined) {
        where.push('key_id = ?')
        args.push(f.keyId)
      }
      if (f.agentId !== undefined) {
        where.push('agent_id = ?')
        args.push(f.agentId)
      }
      if (f.before !== undefined) {
        where.push('at < ?')
        args.push(f.before)
      }
      return sqlite
        .query<Row, Array<string | number>>(
          `SELECT * FROM api_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(...args, f.limit)
        .map(requestOf)
    },
    recordCall: (c: ApiCallRecord) =>
      void sqlite
        .query(
          `INSERT OR IGNORE INTO api_calls (id, at, key_id, agent_id, request_id, model, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id,
          c.at,
          c.keyId,
          c.agentId,
          c.requestId,
          c.model,
          c.inputTokens,
          c.outputTokens,
          c.costUsd,
        ),
    costSince: (keyId, since) =>
      scalar('SELECT SUM(cost_usd) AS n FROM api_calls WHERE key_id = ? AND at >= ?', keyId, since),
    requestsSince: (keyId, since) =>
      scalar(
        `SELECT COUNT(*) AS n FROM api_requests WHERE key_id = ? AND at >= ? AND ${ADMITTED}`,
        keyId,
        since,
      ),
    totals: (keyId, since): UsageTotals => {
      const cond = keyId === undefined ? '' : 'key_id = ? AND '
      const args = keyId === undefined ? [since] : [keyId, since]
      const reqs = scalar(
        `SELECT COUNT(*) AS n FROM api_requests WHERE ${cond}at >= ? AND ${ADMITTED}`,
        ...args,
      )
      const calls = sqlite
        .query<{ c: number | null; i: number | null; o: number | null }, Array<string | number>>(
          `SELECT SUM(cost_usd) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM api_calls WHERE ${cond}at >= ?`,
        )
        .get(...args)
      return {
        requests: reqs,
        costUsd: calls?.c ?? 0,
        inputTokens: calls?.i ?? 0,
        outputTokens: calls?.o ?? 0,
      }
    },
    days: (keyId, since): UsageDay[] => {
      const cond = keyId === undefined ? '' : 'key_id = ? AND '
      const args = keyId === undefined ? [since] : [keyId, since]
      const reqs = sqlite
        .query<{ d: number; n: number }, Array<string | number>>(
          `SELECT (at / 86400000) * 86400000 AS d, COUNT(*) AS n FROM api_requests WHERE ${cond}at >= ? AND ${ADMITTED} GROUP BY d`,
        )
        .all(...args)
      const cost = sqlite
        .query<{ d: number; c: number }, Array<string | number>>(
          `SELECT (at / 86400000) * 86400000 AS d, SUM(cost_usd) AS c FROM api_calls WHERE ${cond}at >= ? GROUP BY d`,
        )
        .all(...args)
      const byDay = new Map<number, UsageDay>()
      for (const r of reqs) byDay.set(r.d, { day: r.d, requests: r.n, costUsd: 0 })
      for (const c of cost) {
        const cur = byDay.get(c.d) ?? { day: c.d, requests: 0, costUsd: 0 }
        byDay.set(c.d, { ...cur, costUsd: c.c })
      }
      return [...byDay.values()].sort((a, b) => a.day - b.day)
    },
    pruneRequests: (olderThan) => {
      sqlite.query('DELETE FROM api_calls WHERE at < ?').run(olderThan)
      return sqlite.query('DELETE FROM api_requests WHERE at < ?').run(olderThan).changes
    },
  }
}
