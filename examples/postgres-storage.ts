/**
 * Postgres storage: `MessageAdapter`, `StateAdapter` (with compare-and-set) and an advisory-lock
 * `SessionLock`, on the schema of spec 05 §10.
 *
 *   DATABASE_URL=postgres://… bun examples/postgres-storage.ts
 *
 * Without `DATABASE_URL` the script prints a notice and exits (the test suite skips it too).
 * With it, the script creates a throwaway schema, runs the conformance suites and a locked turn,
 * and drops the schema again.
 *
 * The adapters are written against `SqlPool`, a two-method interface every driver can satisfy in a
 * few lines, so this file needs no Postgres package:
 *
 *   // node-postgres (`pg`)
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
 *   const db: SqlPool = {
 *     query: async (text, params) => (await pool.query(text, params)).rows,
 *     connect: async () => {
 *       const client = await pool.connect()
 *       return { query: async (t, p) => (await client.query(t, p)).rows, release: () => client.release() }
 *     },
 *   }
 *
 * The runner below uses Bun's built-in `SQL` client (`bunSqlPool`).
 */
import {
  defineHarnessAgent,
  type MessageAdapter,
  type SessionLock,
  type SessionStateSnapshot,
  type StateAdapter,
} from 'eharness'
import { messageAdapterConformance, stateAdapterConformance } from 'eharness/testing'
import { exampleModel } from './shared/model.ts'
import { runCases } from './shared/run-cases.ts'

/** Run one parameterized statement (`$1`, `$2`, …) and return its rows. */
export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>
}

/** A connection pool that can also hand out one dedicated connection (for session locks). */
export interface SqlPool extends SqlClient {
  connect(): Promise<SqlClient & { release(): void | Promise<void> }>
}

export interface PostgresOptions {
  /** Schema of the tables. Default `public`. */
  schema?: string
}

function tables(options: PostgresOptions): { messages: string; state: string } {
  const schema = options.schema ?? 'public'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError(`invalid schema name: ${schema}`)
  return { messages: `${schema}.eh_messages`, state: `${schema}.eh_session_state` }
}

/** Create the tables of spec 05 §10 if they do not exist. */
export async function migrate(db: SqlClient, options: PostgresOptions = {}): Promise<void> {
  const t = tables(options)
  await db.query(`CREATE TABLE IF NOT EXISTS ${t.messages} (
    session_id  text        NOT NULL,
    id          uuid        NOT NULL,        -- UUIDv7 from eharness: byte order = time order
    role        text        NOT NULL,
    parts       jsonb       NOT NULL,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id)
  )`)
  await db.query(`CREATE TABLE IF NOT EXISTS ${t.state} (
    session_id  text PRIMARY KEY,
    state       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`)
}

interface MessageRow {
  id: string
  role: string
  parts: string
  metadata: string | null
}

// JSON travels as text in both directions (`$n::text::jsonb` in, `::text` out) and is parsed
// here, so the adapter does not depend on how a driver encodes or decodes jsonb (some drivers
// JSON-encode a string bound to a jsonb parameter again). jsonb may reorder object keys; the
// contract allows that (spec 05 §4).
const MESSAGE_COLUMNS = 'id::text AS id, role, parts::text AS parts, metadata::text AS metadata'

function toMessage(row: MessageRow) {
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'system',
    parts: JSON.parse(row.parts),
    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
  }
}

/** `MessageAdapter` on `eh_messages`: every query is an index range scan on the primary key. */
export function postgresMessages(db: SqlClient, options: PostgresOptions = {}): MessageAdapter {
  const { messages } = tables(options)
  return {
    async load({ sessionId, fromId, beforeId, limit }) {
      if (fromId !== undefined && beforeId !== undefined) {
        throw new TypeError('load: pass either fromId or beforeId, not both')
      }
      if (fromId !== undefined) {
        const rows = await db.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${messages} WHERE session_id = $1 AND id >= $2 ORDER BY id`,
          [sessionId, fromId],
        )
        return rows.map(toMessage)
      }
      if (limit === undefined) {
        const rows = await db.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${messages}
           WHERE session_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id`,
          [sessionId, beforeId ?? null],
        )
        return rows.map(toMessage)
      }
      if (limit <= 0) return []
      const rows = await db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM ${messages}
         WHERE session_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3`,
        [sessionId, beforeId ?? null, limit],
      )
      return rows.reverse().map(toMessage) // newest `limit`, returned chronologically
    },
    async save(sessionId, batch) {
      // One statement for the whole batch: an upsert by (session_id, id).
      await db.query(
        `INSERT INTO ${messages} (session_id, id, role, parts, metadata)
         SELECT $1, m.id::uuid, m.role, m.parts, m.metadata
         FROM jsonb_to_recordset($2::text::jsonb) AS m(id text, role text, parts jsonb, metadata jsonb)
         ON CONFLICT (session_id, id) DO UPDATE
           SET role = EXCLUDED.role, parts = EXCLUDED.parts, metadata = EXCLUDED.metadata`,
        [
          sessionId,
          JSON.stringify(
            batch.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
              metadata: m.metadata ?? null,
            })),
          ),
        ],
      )
    },
    async lastId(sessionId) {
      const rows = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM ${messages} WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
        [sessionId],
      )
      return rows[0]?.id ?? null
    },
  }
}

/** `StateAdapter` on `eh_session_state`; `setIf` is a single conditional statement. */
export function postgresState(db: SqlClient, options: PostgresOptions = {}): StateAdapter {
  const { state: table } = tables(options)
  return {
    async get(sessionId) {
      const rows = await db.query<{ state: string }>(
        `SELECT state::text AS state FROM ${table} WHERE session_id = $1`,
        [sessionId],
      )
      return rows[0] === undefined ? null : (JSON.parse(rows[0].state) as SessionStateSnapshot)
    },
    async set(sessionId, state) {
      await db.query(
        `INSERT INTO ${table} (session_id, state) VALUES ($1, $2::text::jsonb)
         ON CONFLICT (session_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [sessionId, JSON.stringify(state)],
      )
    },
    async setIf(sessionId, state, expectedRev) {
      const rows =
        expectedRev === null
          ? await db.query(
              `INSERT INTO ${table} (session_id, state) VALUES ($1, $2::text::jsonb)
               ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
              [sessionId, JSON.stringify(state)],
            )
          : await db.query(
              `UPDATE ${table} SET state = $2::text::jsonb, updated_at = now()
               WHERE session_id = $1 AND (state->>'rev')::bigint = $3 RETURNING session_id`,
              [sessionId, JSON.stringify(state), expectedRev],
            )
      return rows.length === 1
    },
  }
}

/**
 * Exact cross-process turn exclusion (spec 05 §8): a session-level advisory lock held on a
 * dedicated connection for the duration of a turn. Rejects immediately when another instance
 * holds it (the turn then ends with `EH_SESSION_BUSY`).
 */
export function postgresLock(db: SqlPool): SessionLock {
  const key = 'hashtextextended($1, 0)'
  return {
    async acquire(sessionId, { signal }) {
      signal.throwIfAborted()
      const connection = await db.connect()
      try {
        const [row] = await connection.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(${key}) AS locked`,
          [sessionId],
        )
        if (row?.locked !== true) throw new Error(`session ${sessionId} is locked elsewhere`)
      } catch (error) {
        await connection.release()
        throw error
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          await connection.query(`SELECT pg_advisory_unlock(${key})`, [sessionId])
        } finally {
          await connection.release()
        }
      }
    },
  }
}

/** `SqlPool` over Bun's built-in Postgres client (Bun only). */
export async function bunSqlPool(url: string): Promise<SqlPool & { close(): Promise<void> }> {
  const { SQL } = await import('bun')
  const sql = new SQL(url)
  return {
    query: (text, params = []) => sql.unsafe(text, params),
    async connect() {
      const reserved = await sql.reserve()
      return {
        query: (text, params = []) => reserved.unsafe(text, params),
        release: () => reserved.release(),
      }
    },
    close: () => sql.close(),
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    console.log('DATABASE_URL is not set: skipping the Postgres example.')
  } else {
    const db = await bunSqlPool(url)
    const schema = `eharness_example_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    try {
      await db.query(`CREATE SCHEMA ${schema}`)
      await migrate(db, { schema })
      await runCases(
        'MessageAdapter conformance (Postgres)',
        messageAdapterConformance(() => postgresMessages(db, { schema }), { requireLastId: true }),
      )
      await runCases(
        'StateAdapter conformance (Postgres)',
        stateAdapterConformance(() => postgresState(db, { schema })),
      )

      // The lock: a second acquire of the same session fails until the first is released.
      const lock = postgresLock(db)
      const signal = new AbortController().signal
      const release = await lock.acquire('locked-session', { signal })
      const second = await lock.acquire('locked-session', { signal }).then(
        () => 'acquired',
        () => 'rejected',
      )
      await release()
      console.log(`\nadvisory lock: second acquire ${second}`)
      if (second !== 'rejected') process.exitCode = 1

      // A turn on Postgres storage, with the lock.
      const agent = defineHarnessAgent({
        model: exampleModel([{ text: 'Stored in Postgres.' }]),
        contextWindow: 200_000,
        storage: {
          messages: postgresMessages(db, { schema }),
          state: postgresState(db, { schema }),
        },
      })
      const result = await agent.session('pg-demo', { lock }).send('Hello').result
      console.log(
        `turn: ${result.stop}; stored messages: ${(await agent.session('pg-demo').messages()).length}`,
      )
      await agent.close()
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.close()
    }
  }
}
