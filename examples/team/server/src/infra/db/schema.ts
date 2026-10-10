/**
 * Drizzle schema (docs/plans/P32-team-example.md §4). Migrations are generated from this file
 * with `bun run db:generate`; the eharness adapters (`infra/eh/storage.ts`) use the `eh_*`
 * tables with plain SQL on the same connection.
 */
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  settings: json<Record<string, unknown>>('settings').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    avatar: text('avatar'),
    color: text('color').notNull(),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull(),
    model: text('model'),
    tools: json<string[]>('tools').notNull(),
    skills: json<string[]>('skills').notNull(),
    mcp: json<string[]>('mcp').notNull(),
    permissionMode: text('permission_mode').notNull(),
    rules: json<{ allow: string[]; ask: string[]; deny: string[] }>('rules').notNull(),
    version: integer('version').notNull(),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('agents_workspace').on(t.workspaceId)],
)

/** One DM chat per agent: the sidebar row. */
export const chats = sqliteTable('chats', {
  agentId: text('agent_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  lastMessageAt: integer('last_message_at'),
  lastPreview: text('last_preview'),
  unread: integer('unread').notNull().default(0),
  lastReadMessageId: text('last_read_message_id'),
})

/** Index derived from sessions (request R1); the session stays the truth. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull().unique(),
    parentSessionId: text('parent_session_id'),
    origin: text('origin').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    pendingKind: text('pending_kind'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    summary: text('summary'),
  },
  (t) => [index('tasks_state').on(t.state), index('tasks_agent').on(t.agentId)],
)

/** Feed for the UI (plan §5.3); every instance tails it. */
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  payload: json<Record<string, unknown>>('payload').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const routines = sqliteTable(
  'routines',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    schedule: json<{ kind: 'cron'; expr: string; tz: string } | { kind: 'every'; ms: number }>(
      'schedule',
    ).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: integer('next_run_at'),
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until'),
    lastRunAt: integer('last_run_at'),
    lastStatus: text('last_status'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('routines_due').on(t.enabled, t.nextRunAt)],
)

/** The primary key makes a fire idempotent (plan §6.6). */
export const routineRuns = sqliteTable(
  'routine_runs',
  {
    routineId: text('routine_id').notNull(),
    fireAt: integer('fire_at').notNull(),
    taskId: text('task_id'),
    startedAt: integer('started_at').notNull(),
    status: text('status').notNull(),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.fireAt] })],
)

/** Library and memory files (memory lives under `/memories/**`, ADR-0022). */
export const libraryFiles = sqliteTable(
  'library_files',
  {
    path: text('path').primaryKey(),
    version: text('version').notNull(),
    /** Text content; null for a binary file. */
    text: text('text'),
    /** Raw bytes of a binary file; null for text. */
    bytes: blob('bytes', { mode: 'buffer' }),
    mediaType: text('media_type'),
    size: integer('size').notNull(),
    createdByAgentId: text('created_by_agent_id'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('library_updated').on(t.updatedAt)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// --- eharness adapter tables (owned by infra/eh/storage.ts) -----------------------------------

export const ehMessages = sqliteTable(
  'eh_messages',
  {
    sessionId: text('session_id').notNull(),
    /** UUIDv7 from eharness: text order = time order. */
    id: text('id').notNull(),
    role: text('role').notNull(),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
)

export const ehState = sqliteTable('eh_state', {
  sessionId: text('session_id').primaryKey(),
  state: text('state').notNull(),
  rev: integer('rev').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** Turn lock with a lease (a crashed holder expires). */
export const ehLocks = sqliteTable('eh_locks', {
  sessionId: text('session_id').primaryKey(),
  owner: text('owner').notNull(),
  until: integer('until').notNull(),
})

export const ehInbox = sqliteTable(
  'eh_inbox',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    item: text('item').notNull(),
    attempts: integer('attempts').notNull().default(0),
    claimedBy: text('claimed_by'),
    claimedUntil: integer('claimed_until'),
    availableAt: integer('available_at'),
    delayedUntil: integer('delayed_until'),
    lastError: text('last_error'),
    deadAt: integer('dead_at'),
    deadReason: text('dead_reason'),
  },
  (t) => [index('eh_inbox_session').on(t.sessionId, t.id)],
)

export const ehBudgetScope = sqliteTable(
  'eh_budget_scope',
  {
    scope: text('scope').notNull(),
    /** First instant of the month (UTC), epoch ms. */
    periodStart: integer('period_start').notNull(),
    /** null = no limit */
    limitUsd: text('limit_usd'),
    spentUsd: text('spent_usd').notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.scope, t.periodStart] })],
)

export const ehBudgetReservation = sqliteTable(
  'eh_budget_reservation',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    scopes: text('scopes').notNull(),
    periodStart: integer('period_start').notNull(),
    amountUsd: text('amount_usd').notNull(),
    expiresAt: integer('expires_at').notNull(),
    state: text('state').notNull().default('open'),
  },
  (t) => [index('eh_budget_reservation_key').on(t.key)],
)

export const ehBudgetRecord = sqliteTable('eh_budget_record', {
  key: text('key').primaryKey(),
  recordedAt: integer('recorded_at').notNull(),
})

/** Head of one turn's stream log (`infra/eh/stream-log.ts`, spec 04 §6.2). */
export const ehStreamLog = sqliteTable(
  'eh_stream_log',
  {
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** `streaming` | `done` | `error` | `aborted` */
    status: text('status').notNull(),
    /** Number of chunks stored (the next cursor). */
    length: integer('length').notNull().default(0),
    /** Retention applied after every append / close (ms). */
    ttlMs: integer('ttl_ms').notNull(),
    /** Absolute expiry, epoch ms: past it the log reads as missing and is purged. */
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.turnId] }),
    index('eh_stream_log_expiry').on(t.expiresAt),
  ],
)

/** Append-only chunks of a stream log, keyed by the 0-based chunk index. */
export const ehStreamChunks = sqliteTable(
  'eh_stream_chunks',
  {
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    idx: integer('idx').notNull(),
    chunk: text('chunk').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.turnId, t.idx] })],
)
