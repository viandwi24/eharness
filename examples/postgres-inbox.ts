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
 *
 * Retries and dead-letter (0.5, spec 05 §12 rules 11–15): `release` honours `uncount`, `delayMs`
 * (`delayed_until`) and `lastError` (`last_error`), `availableAt` is stored in `available_at`,
 * and dead items stay in the table (`dead_at`, `dead_reason`) for `listDead` / `redrive`.
 * `migrateInbox` upgrades a 0.4 table in place (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, all
 * nullable, so existing rows are ready items) and recreates `eh_inbox_claim`.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { tool } from 'ai'
import {
  type DeadInboxItem,
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

/** Create the inbox table if it does not exist (and upgrade a 0.4 table in place). */
export async function migrateInbox(db: SqlClient, options: PostgresOptions = {}): Promise<void> {
  const { table } = inboxTable(options)
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    id             uuid        PRIMARY KEY,          -- UUIDv7: byte order = enqueue order
    session_id     text        NOT NULL,
    item           jsonb       NOT NULL,
    attempts       integer     NOT NULL DEFAULT 0,   -- counted claims (spec 05 §12 rule 11)
    claimed_by     text,
    claimed_until  timestamptz
  )`)
  // 0.5 columns, added in place to a 0.4 table (nullable: existing rows stay ready items)
  for (const column of [
    'available_at  timestamptz', // InboxItemInput.availableAt: a timer, holds nothing back
    'delayed_until timestamptz', // release({ delayMs }): keeps its place (rule 14)
    'last_error    text',
    'dead_at       timestamptz', // dead: never claimed, listed by listDead
    'dead_reason   text',
  ]) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`)
  }
  await db.query(`CREATE INDEX IF NOT EXISTS eh_inbox_session_id ON ${table} (session_id, id)`)
  // One claim per session at a time (a transaction-scoped advisory lock), so the head-of-line
  // rule holds under concurrent claimers: renew the owner's live claims, then claim the oldest
  // ready rows that are not behind a row another owner still holds, nor — except aborts —
  // behind a delayed row (rule 14). Dead rows and future timers are skipped. Each statement of
  // the function sees the rows committed before it (READ COMMITTED), i.e. after the lock.
  // The 0.4 function returned fewer columns: drop it first (CREATE OR REPLACE cannot change
  // the result type).
  await db.query(`DROP FUNCTION IF EXISTS ${claimFunction(options)}(text, text, integer, integer)`)
  await db.query(`CREATE FUNCTION ${claimFunction(options)}(
      p_session text, p_owner text, p_ttl_ms integer, p_limit integer)
    RETURNS TABLE (claimed_id text, claimed_item text, claimed_attempts integer,
      claimed_last_error text)
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_now timestamptz := clock_timestamp();
      v_until timestamptz := clock_timestamp() + p_ttl_ms * interval '1 millisecond';
      v_head uuid;
      v_delay uuid;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('eh_inbox:' || p_session));
      v_now := clock_timestamp();
      v_until := v_now + p_ttl_ms * interval '1 millisecond';
      UPDATE ${table} AS r SET claimed_until = v_until
        WHERE r.session_id = p_session AND r.claimed_by = p_owner
          AND r.claimed_until > v_now AND r.dead_at IS NULL;
      -- ORDER BY … LIMIT 1, not min(): min(uuid) only exists from Postgres 18
      SELECT h.id INTO v_head FROM ${table} AS h
        WHERE h.session_id = p_session AND h.dead_at IS NULL AND h.claimed_until > v_now
          AND h.claimed_by IS DISTINCT FROM p_owner
        ORDER BY h.id LIMIT 1;
      SELECT d.id INTO v_delay FROM ${table} AS d
        WHERE d.session_id = p_session AND d.dead_at IS NULL AND d.delayed_until > v_now
          AND (d.claimed_until IS NULL OR d.claimed_until <= v_now)
          AND (d.available_at IS NULL OR d.available_at <= v_now)
        ORDER BY d.id LIMIT 1;
      RETURN QUERY
        UPDATE ${table} AS u SET claimed_by = p_owner, claimed_until = v_until,
          attempts = u.attempts + 1, delayed_until = NULL
        WHERE u.id IN (
          SELECT c.id FROM ${table} AS c
          WHERE c.session_id = p_session AND c.dead_at IS NULL
            AND (c.claimed_until IS NULL OR c.claimed_until <= v_now)
            AND (c.available_at IS NULL OR c.available_at <= v_now)
            AND (c.delayed_until IS NULL OR c.delayed_until <= v_now)
            AND (v_head IS NULL OR c.id < v_head)
            AND (v_delay IS NULL OR c.id < v_delay OR c.item->>'kind' = 'abort')
          ORDER BY c.id LIMIT p_limit
        )
        RETURNING u.id::text, u.item::text, u.attempts, u.last_error;
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
  last_error: string | null
}

interface DeadRow extends InboxRow {
  session_id: string
  dead_at_ms: number | string
  dead_reason: string
}

function toItem(row: InboxRow): InboxItem {
  const item: InboxItem = { ...JSON.parse(row.item), id: row.id, attempts: Number(row.attempts) }
  if (row.last_error !== null && row.last_error !== undefined) item.lastError = row.last_error
  return item
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
 * `subscribe` needs a {@link PgListener}. Implements the 0.5 retry members: `release` options,
 * `deadLetter`, `redrive`, `listDead` and `stats` (dead rows stay in the table).
 */
export function postgresInbox(
  db: SqlClient,
  options: PostgresOptions & { listener?: PgListener } = {},
): InboxAdapter {
  const { table, channel } = inboxTable(options)
  const claim = claimFunction(options)
  const handlers = new Map<string, Set<() => void>>()
  let listening: Promise<{ unlisten(): Promise<void> } | undefined> | undefined

  const t = 'clock_timestamp()'
  /** A row a claim by a new owner could take (head of line, delays, timers; see migrateInbox). */
  const claimable = `c.dead_at IS NULL
    AND (c.claimed_until IS NULL OR c.claimed_until <= ${t})
    AND (c.available_at IS NULL OR c.available_at <= ${t})
    AND (c.delayed_until IS NULL OR c.delayed_until <= ${t})
    AND NOT EXISTS (SELECT 1 FROM ${table} AS h WHERE h.session_id = c.session_id
      AND h.id < c.id AND h.dead_at IS NULL AND h.claimed_until > ${t})
    AND (c.item->>'kind' = 'abort' OR NOT EXISTS (SELECT 1 FROM ${table} AS d
      WHERE d.session_id = c.session_id AND d.id < c.id AND d.dead_at IS NULL
        AND d.delayed_until > ${t}
        AND (d.claimed_until IS NULL OR d.claimed_until <= ${t})
        AND (d.available_at IS NULL OR d.available_at <= ${t})))`
  const adapter: InboxAdapter = {
    async enqueue(sessionId, item: InboxItemInput) {
      const id = uuidv7()
      await db.query(
        `INSERT INTO ${table} (id, session_id, item, available_at)
         VALUES ($1::uuid, $2, $3::text::jsonb, to_timestamp($4::double precision / 1000))`,
        [id, sessionId, JSON.stringify(item), item.availableAt ?? null],
      )
      return id
    },
    async claim(sessionId, owner, opts = {}) {
      const rows = await db.query<InboxRow>(
        `SELECT claimed_id AS id, claimed_item AS item, claimed_attempts AS attempts,
           claimed_last_error AS last_error
         FROM ${claim}($1, $2, $3::integer, $4::integer)`,
        [sessionId, owner, Math.max(1, Math.round(opts.claimTtlMs ?? 120_000)), opts.limit ?? null],
      )
      return rows.map(toItem).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
    async ack(ids) {
      if (ids.length === 0) return
      await db.query(`DELETE FROM ${table} WHERE id::text = ANY(string_to_array($1, ','))`, [
        idList(ids),
      ])
    },
    async release(ids, opts = {}) {
      if (ids.length === 0) return
      // only claimed rows: `uncount` undoes the increment of the claim being released
      await db.query(
        `UPDATE ${table} SET claimed_by = NULL, claimed_until = NULL,
           attempts = CASE WHEN $2::integer = 1 THEN GREATEST(0, attempts - 1) ELSE attempts END,
           delayed_until = CASE WHEN $3::integer > 0
             THEN clock_timestamp() + $3::integer * interval '1 millisecond'
             ELSE delayed_until END,
           last_error = COALESCE($4::text, last_error)
         WHERE id::text = ANY(string_to_array($1, ','))
           AND dead_at IS NULL AND claimed_by IS NOT NULL`,
        [
          idList(ids),
          opts.uncount === true ? 1 : 0,
          Math.max(0, Math.round(opts.delayMs ?? 0)),
          opts.lastError ?? null,
        ],
      )
    },
    async deadLetter(ids, info) {
      if (ids.length === 0) return
      await db.query(
        `UPDATE ${table} SET claimed_by = NULL, claimed_until = NULL, delayed_until = NULL,
           dead_at = clock_timestamp(), dead_reason = $2, last_error = COALESCE($3::text, last_error)
         WHERE id::text = ANY(string_to_array($1, ',')) AND dead_at IS NULL`,
        [idList(ids), info.reason, info.lastError ?? null],
      )
    },
    async redrive(ids) {
      if (ids.length === 0) return
      await db.query(
        `UPDATE ${table} SET dead_at = NULL, dead_reason = NULL, attempts = 0, last_error = NULL
         WHERE id::text = ANY(string_to_array($1, ',')) AND dead_at IS NOT NULL`,
        [idList(ids)],
      )
    },
    async listDead(opts = {}) {
      const rows = await db.query<DeadRow>(
        `SELECT id::text AS id, session_id, item::text AS item, attempts, last_error,
           (extract(epoch FROM dead_at) * 1000)::float8 AS dead_at_ms, dead_reason
         FROM ${table}
         WHERE dead_at IS NOT NULL AND ($1::text IS NULL OR session_id = $1::text)
         ORDER BY id LIMIT $2::integer`,
        [opts.sessionId ?? null, opts.limit ?? null],
      )
      return rows.map(
        (row): DeadInboxItem => ({
          ...toItem(row),
          sessionId: row.session_id,
          deadAt: Math.round(Number(row.dead_at_ms)),
          reason: row.dead_reason,
        }),
      )
    },
    async stats(opts = {}) {
      const [row] = await db.query<Record<'ready' | 'claimed' | 'delayed' | 'dead', string>>(
        `SELECT
           count(*) FILTER (WHERE dead_at IS NOT NULL) AS dead,
           count(*) FILTER (WHERE dead_at IS NULL AND claimed_until > ${t}) AS claimed,
           count(*) FILTER (WHERE dead_at IS NULL
             AND (claimed_until IS NULL OR claimed_until <= ${t})
             AND (delayed_until > ${t} OR available_at > ${t})) AS delayed,
           count(*) FILTER (WHERE dead_at IS NULL
             AND (claimed_until IS NULL OR claimed_until <= ${t})
             AND (delayed_until IS NULL OR delayed_until <= ${t})
             AND (available_at IS NULL OR available_at <= ${t})) AS ready
         FROM ${table} WHERE ($1::text IS NULL OR session_id = $1::text)`,
        [opts.sessionId ?? null],
      )
      return {
        ready: Number(row?.ready ?? 0),
        claimed: Number(row?.claimed ?? 0),
        delayed: Number(row?.delayed ?? 0),
        dead: Number(row?.dead ?? 0),
      }
    },
    async notify(sessionId) {
      await listening // our own subscription is live before we announce anything
      await db.query('SELECT pg_notify($1, $2)', [channel, sessionId])
    },
    async pending(opts = {}) {
      // claimable: a claim by a new owner would return a row (head of line, delays, timers)
      const rows = await db.query<{ session_id: string }>(
        `SELECT DISTINCT c.session_id FROM ${table} AS c WHERE ${claimable} LIMIT $1`,
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
          requireRetry: true,
          requireDeadLetter: true,
          requireStats: true,
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
