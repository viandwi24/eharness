/**
 * Postgres `InboxAdapter` (spec 05 §12): a durable per-session queue of inputs, wake-ups and abort
 * requests, claimed head-of-line under a per-session advisory lock (`eh_inbox_claim`) and
 * announced with `LISTEN` / `NOTIFY` (`pg_notify`).
 *
 *   DATABASE_URL=postgres://… bun examples/postgres-inbox.ts
 *
 * Without `DATABASE_URL` the script prints a notice and exits (the test suite skips it too).
 * With it, the script creates a throwaway schema, runs the inbox conformance suite and a
 * two-instance demo (instance B queues a message while instance A runs a turn), and drops the
 * schema again.
 *
 * The adapter needs a `SqlClient` (see `postgres-storage.ts`) and, for `subscribe`, a
 * `PgListener` — one dedicated connection that receives notifications:
 *
 *   // node-postgres (`pg`): one client kept open for LISTEN
 *   const client = new pg.Client({ connectionString }); await client.connect()
 *   const handlers = new Map<string, Set<(payload: string) => void>>()
 *   client.on('notification', (n) => handlers.get(n.channel)?.forEach((h) => h(n.payload ?? '')))
 *   const listener: PgListener = {
 *     async listen(channel, onNotify) {
 *       if (!handlers.has(channel)) { handlers.set(channel, new Set()); await client.query(`LISTEN ${channel}`) }
 *       handlers.get(channel)?.add(onNotify)
 *       return { unlisten: async () => void handlers.get(channel)?.delete(onNotify) }
 *     },
 *   }
 *
 * Without a listener the adapter has no `subscribe`, and the holder of a session polls
 * (`inbox.pollMs`, default 2 s).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { tool } from 'ai'
import {
  defineHarnessAgent,
  type InboxAdapter,
  type InboxItem,
  type InboxItemInput,
  uuidv7,
} from 'eharness'
import { inboxAdapterConformance } from 'eharness/testing'
import { z } from 'zod/v4'
import {
  bunSqlPool,
  migrate,
  type PostgresOptions,
  postgresMessages,
  postgresState,
  type SqlClient,
} from './postgres-storage.ts'
import { exampleModel } from './shared/model.ts'
import { runCases } from './shared/run-cases.ts'

/** A connection that receives `NOTIFY`s of a channel. */
export interface PgListener {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void> }>
}

function inboxTable(options: PostgresOptions): { table: string; channel: string } {
  const schema = options.schema ?? 'public'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError(`invalid schema name: ${schema}`)
  // one channel per schema; the payload is the session id (ids may exceed the 63-byte channel limit)
  return { table: `${schema}.eh_inbox`, channel: `eh_inbox_${schema}`.slice(0, 63) }
}

/** Create the inbox table if it does not exist. */
export async function migrateInbox(db: SqlClient, options: PostgresOptions = {}): Promise<void> {
  const { table } = inboxTable(options)
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    id             uuid        PRIMARY KEY,          -- UUIDv7: byte order = enqueue order
    session_id     text        NOT NULL,
    item           jsonb       NOT NULL,
    attempts       integer     NOT NULL DEFAULT 0,
    claimed_by     text,
    claimed_until  timestamptz
  )`)
  await db.query(`CREATE INDEX IF NOT EXISTS eh_inbox_session_id ON ${table} (session_id, id)`)
  // One claim per session at a time (a transaction-scoped advisory lock), so the head-of-line
  // rule holds under concurrent claimers: renew the owner's live claims, then claim the oldest
  // ready rows that are not behind a row another owner still holds. Each statement of the
  // function sees the rows committed before it (READ COMMITTED), i.e. after the lock.
  await db.query(`CREATE OR REPLACE FUNCTION ${claimFunction(options)}(
      p_session text, p_owner text, p_ttl_ms integer, p_limit integer)
    RETURNS TABLE (claimed_id text, claimed_item text, claimed_attempts integer)
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_until timestamptz := clock_timestamp() + p_ttl_ms * interval '1 millisecond';
      v_head uuid;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('eh_inbox:' || p_session));
      UPDATE ${table} AS r SET claimed_until = v_until
        WHERE r.session_id = p_session AND r.claimed_by = p_owner
          AND r.claimed_until > clock_timestamp();
      SELECT min(h.id) INTO v_head FROM ${table} AS h
        WHERE h.session_id = p_session AND h.claimed_until > clock_timestamp()
          AND h.claimed_by IS DISTINCT FROM p_owner;
      RETURN QUERY
        UPDATE ${table} AS u SET claimed_by = p_owner, claimed_until = v_until,
          attempts = u.attempts + 1
        WHERE u.id IN (
          SELECT c.id FROM ${table} AS c
          WHERE c.session_id = p_session
            AND (c.claimed_until IS NULL OR c.claimed_until <= clock_timestamp())
            AND (v_head IS NULL OR c.id < v_head)
          ORDER BY c.id LIMIT p_limit
        )
        RETURNING u.id::text, u.item::text, u.attempts;
    END
    $fn$`)
}

/** The claim function of the inbox table (see {@link migrateInbox}). */
function claimFunction(options: PostgresOptions): string {
  return `${options.schema ?? 'public'}.eh_inbox_claim`
}

interface InboxRow {
  id: string
  item: string
  attempts: number | string
}

/** `ids` as one text parameter (`= ANY(string_to_array($1, ','))`): no array binding needed. */
function idList(ids: readonly string[]): string {
  return ids.filter((id) => !id.includes(',')).join(',')
}

/**
 * `InboxAdapter` on `eh_inbox`. `claim` calls `eh_inbox_claim` (see {@link migrateInbox}): under a
 * per-session advisory lock it renews the claims the owner holds and marks the oldest ready rows
 * claimed until `now + claimTtlMs`, never a row behind one another owner holds (head of line);
 * an expired claim makes a row ready again (its owner died). `notify` is `pg_notify`;
 * `subscribe` needs a {@link PgListener}.
 */
export function postgresInbox(
  db: SqlClient,
  options: PostgresOptions & { listener?: PgListener } = {},
): InboxAdapter {
  const { table, channel } = inboxTable(options)
  const claim = claimFunction(options)
  const handlers = new Map<string, Set<() => void>>()
  let listening: Promise<{ unlisten(): Promise<void> } | undefined> | undefined

  const ready = '(claimed_until IS NULL OR claimed_until <= now())'
  const adapter: InboxAdapter = {
    async enqueue(sessionId, item: InboxItemInput) {
      const id = uuidv7()
      await db.query(
        `INSERT INTO ${table} (id, session_id, item) VALUES ($1::uuid, $2, $3::text::jsonb)`,
        [id, sessionId, JSON.stringify(item)],
      )
      return id
    },
    async claim(sessionId, owner, opts = {}) {
      const rows = await db.query<InboxRow>(
        `SELECT claimed_id AS id, claimed_item AS item, claimed_attempts AS attempts
         FROM ${claim}($1, $2, $3::integer, $4::integer)`,
        [sessionId, owner, Math.max(1, Math.round(opts.claimTtlMs ?? 120_000)), opts.limit ?? null],
      )
      return rows
        .map(
          (row): InboxItem => ({
            ...JSON.parse(row.item),
            id: row.id,
            attempts: Number(row.attempts),
          }),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
    async ack(ids) {
      if (ids.length === 0) return
      await db.query(`DELETE FROM ${table} WHERE id::text = ANY(string_to_array($1, ','))`, [
        idList(ids),
      ])
    },
    async release(ids) {
      if (ids.length === 0) return
      await db.query(
        `UPDATE ${table} SET claimed_by = NULL, claimed_until = NULL
         WHERE id::text = ANY(string_to_array($1, ','))`,
        [idList(ids)],
      )
    },
    async notify(sessionId) {
      await listening // our own subscription is live before we announce anything
      await db.query('SELECT pg_notify($1, $2)', [channel, sessionId])
    },
    async pending(opts = {}) {
      // claimable: the oldest row of the session is ready (head of line)
      const rows = await db.query<{ session_id: string }>(
        `SELECT session_id FROM (
           SELECT DISTINCT ON (session_id) session_id, claimed_until FROM ${table}
           ORDER BY session_id, id
         ) AS oldest WHERE ${ready} LIMIT $1`,
        [opts.limit ?? null],
      )
      return rows.map((row) => row.session_id)
    },
  }
  const listener = options.listener
  if (listener !== undefined) {
    adapter.subscribe = (sessionId, onNotify) => {
      let set = handlers.get(sessionId)
      if (set === undefined) {
        set = new Set()
        handlers.set(sessionId, set)
      }
      const own = () => onNotify()
      set.add(own)
      // one LISTEN per adapter; notifications are routed by their payload (the session id)
      listening ??= listener
        .listen(channel, (payload) => {
          for (const handler of [...(handlers.get(payload) ?? [])]) handler()
        })
        .catch(() => undefined)
      return () => {
        handlers.get(sessionId)?.delete(own)
      }
    }
  }
  return adapter
}

/** `PgListener` over Bun's built-in Postgres client (`sql.listen`, Bun only). */
export async function bunSqlListener(
  url: string,
): Promise<PgListener & { close(): Promise<void> }> {
  const { SQL } = await import('bun')
  const sql = new SQL(url)
  return {
    async listen(channel, onNotify) {
      const subscription = await sql.listen(channel, onNotify)
      return { unlisten: () => subscription.unlisten() }
    },
    close: () => sql.close(),
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    console.log('DATABASE_URL is not set: skipping the Postgres inbox example.')
  } else {
    const db = await bunSqlPool(url)
    const listener = await bunSqlListener(url)
    const schema = `eharness_inbox_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    try {
      await db.query(`CREATE SCHEMA ${schema}`)
      await migrate(db, { schema })
      await migrateInbox(db, { schema })
      await runCases(
        'InboxAdapter conformance (Postgres, advisory-lock claim + LISTEN/NOTIFY)',
        inboxAdapterConformance(() => postgresInbox(db, { schema, listener }), {
          requireNotify: true,
          requirePending: true,
          claimTtlMs: 200,
        }),
      )

      // Two instances on one database: B queues a message while A runs a turn; A applies it.
      const storage = {
        messages: postgresMessages(db, { schema }),
        state: postgresState(db, { schema }),
        inbox: postgresInbox(db, { schema, listener }),
      }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let started!: () => void
      const toolStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const research = tool({
        inputSchema: z.object({}),
        execute: async () => {
          started()
          await gate
          return 'Found 3 sources.'
        },
      })
      const model = exampleModel([
        { toolCalls: [{ toolName: 'research', input: {} }] },
        { text: 'Research done.' },
        { text: 'Here is the summary you asked for.' },
      ])
      const a = defineHarnessAgent({ model, contextWindow: 200_000, tools: { research }, storage })
      const b = defineHarnessAgent({ model, contextWindow: 200_000, storage })
      const run = a.session('pg-inbox').send('Research the topic')
      await toolStarted
      const queued = await b.session('pg-inbox').enqueue('Then summarize it.')
      console.log(`\nB: enqueue → ${queued.target}`)
      release()
      await run.result
      for (let i = 0; i < 200; i++) {
        const texts = (await a.session('pg-inbox').messages()).filter((m) => m.role === 'user')
        if (texts.length === 2) break
        await sleep(25)
      }
      await a.session('pg-inbox').idle()
      const users = (await a.session('pg-inbox').messages()).filter((m) => m.role === 'user')
      console.log(`A: applied the queued message: ${users.length === 2}`)
      if (users.length !== 2) process.exitCode = 1
      await a.close()
      await b.close()
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await listener.close()
      await db.close()
    }
  }
}
