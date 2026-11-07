/**
 * `HandoffStore` (spec 32 §2) on `<prefix>handoffs`: a request is one JSON document with the
 * columns the queries need. `answer`, `cancel` and `expire` are transitions out of `open` inside
 * one write transaction, so with parallel callers (also in other processes) exactly one wins.
 */
import type {
  HandoffAnswer,
  HandoffAnswerExtras,
  HandoffInput,
  HandoffListQuery,
  HandoffListResult,
  HandoffRequest,
  HandoffStore,
  HandoffTransition,
} from 'eharness/handoff'
import type { SqlDriver, SqlParam } from './driver.ts'
import { type AdapterOptions, clock, one, placeholders, tables } from './util.ts'

/** The cursor of a request: its creation time padded so text order is time order, then its id. */
const cursorOf = (r: Pick<HandoffRequest, 'createdAt' | 'id'>): string =>
  `${String(r.createdAt).padStart(16, '0')}|${r.id}`

export function sqliteHandoffStore(driver: SqlDriver, options: AdapterOptions = {}): HandoffStore {
  const t = tables(options.prefix).handoffs
  const now = clock(options)

  const read = (id: string): HandoffRequest | undefined => {
    const row = one<{ doc: string }>(driver, `SELECT doc FROM ${t} WHERE id = ?`, [id])
    return row === undefined ? undefined : (JSON.parse(row.doc) as HandoffRequest)
  }
  const write = (r: HandoffRequest): void => {
    driver.run(
      `INSERT INTO ${t} (id, session_id, status, created_at, expires_at, audience, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, doc = excluded.doc`,
      [
        r.id,
        r.sessionId,
        r.status,
        r.createdAt,
        r.expiresAt ?? null,
        r.audience === undefined ? null : JSON.stringify(r.audience),
        JSON.stringify(r),
      ],
    )
  }

  const leave = (
    id: string,
    to: 'answered' | 'cancelled',
    answer?: HandoffAnswer,
    extras?: HandoffAnswerExtras,
  ): HandoffTransition =>
    driver.transaction((): HandoffTransition => {
      const row = read(id)
      if (row === undefined) return { ok: false, reason: 'not-found' }
      if (row.status !== 'open') {
        const reason = row.status === 'answered' ? 'already-answered' : row.status
        return {
          ok: false,
          reason,
          ...(reason === 'already-answered' ? { alreadyAnswered: true as const } : {}),
          request: row,
        }
      }
      row.status = to
      if (answer !== undefined) row.answer = structuredClone(answer)
      if (extras?.metadata !== undefined) {
        row.metadata = { ...row.metadata, ...structuredClone(extras.metadata) }
      }
      write(row)
      return { ok: true, request: row }
    })

  return {
    async create(input: HandoffInput) {
      return driver.transaction(() => {
        const existing = read(input.id)
        if (existing !== undefined) return { request: existing, created: false }
        const request: HandoffRequest = structuredClone({
          ...input,
          status: 'open' as const,
          createdAt: input.createdAt ?? now(),
        })
        write(request)
        return { request, created: true }
      })
    },

    async get(id) {
      return read(id)
    },

    async list(query: HandoffListQuery = {}): Promise<HandoffListResult> {
      const limit = Math.max(1, query.limit ?? 50)
      const where: string[] = []
      const params: SqlParam[] = []
      if (query.status !== undefined) {
        where.push('status = ?')
        params.push(query.status)
      }
      if (query.sessionId !== undefined) {
        where.push('session_id = ?')
        params.push(query.sessionId)
      }
      if (query.audience !== undefined) {
        where.push(
          `(audience IS NULL OR json_array_length(audience) = 0 OR EXISTS (
             SELECT 1 FROM json_each(audience) WHERE value IN (${placeholders(query.audience.length)})))`,
        )
        params.push(...query.audience)
      }
      if (query.cursor !== undefined) {
        const bar = query.cursor.indexOf('|')
        const createdAt = Number(query.cursor.slice(0, bar))
        const id = query.cursor.slice(bar + 1)
        where.push('(created_at > ? OR (created_at = ? AND id > ?))')
        params.push(createdAt, createdAt, id)
      }
      const rows = driver.query<{ doc: string }>(
        `SELECT doc FROM ${t} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY created_at, id LIMIT ?`,
        [...params, limit + 1],
      )
      const items = rows.map((row) => JSON.parse(row.doc) as HandoffRequest)
      const page = items.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page,
        ...(items.length > limit && last !== undefined ? { nextCursor: cursorOf(last) } : {}),
      }
    },

    async answer(id, answer, extras) {
      return leave(id, 'answered', answer, extras)
    },

    async cancel(id) {
      return leave(id, 'cancelled')
    },

    async expire(at) {
      return driver.transaction(() => {
        const rows = driver.query<{ doc: string }>(
          `SELECT doc FROM ${t} WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY created_at, id`,
          [at],
        )
        const out: HandoffRequest[] = []
        for (const row of rows) {
          const r = JSON.parse(row.doc) as HandoffRequest
          r.status = 'expired'
          write(r)
          out.push(r)
        }
        return out
      })
    },
  }
}
