/**
 * Drizzle schema (docs/plans/P32-team-example.md §4). Migrations are generated from this file
 * with `bun run db:generate`; the eharness adapters (`infra/eh/storage.ts`) use the `eh_*`
 * tables with plain SQL on the same connection.
 */
import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** The MCP server rows of before connectors (read by the boot migration only). */
export interface LegacyMcpServer {
  name: string
  transport: { type: 'http' | 'sse'; url: string; headers: Record<string, string> }
  allow?: string[]
  deny?: string[]
}

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
    /** Profile the model comes from (`provider_profiles.id`); null = the default profile. */
    modelProfile: text('model_profile'),
    /** Tool access of third-party connectors (`auto` | `on-demand`); null = the workspace default. */
    toolAccess: text('tool_access'),
    /** Legacy tool checklist (before connectors): read by the boot migration only, never written. */
    tools: json<string[]>('tools').notNull(),
    skills: json<string[]>('skills').notNull(),
    mcp: json<string[]>('mcp').notNull(),
    /** Legacy (before connectors): read only by the boot migration (`infra/eh/connectors-migration.ts`). */
    mcpServers: json<LegacyMcpServer[]>('mcp_servers').notNull().default([]),
    /** Unused: an early draft of the enablement storage (see `agent_connectors`); never read or written. */
    connectors: json<Record<string, unknown>>('connectors'),
    /** 0 = a row from before connectors: the boot migration derives its enablement from `tools` and `mcp_servers`. */
    connectorsMigrated: integer('connectors_migrated').notNull().default(0),
    permissionMode: text('permission_mode').notNull(),
    rules: json<{ allow: string[]; ask: string[]; deny: string[] }>('rules').notNull(),
    version: integer('version').notNull(),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('agents_workspace').on(t.workspaceId)],
)

/**
 * Connector enablement (`EnablementStore`): one agent's choices for one connection (on / off /
 * inherit, a mode per capability, per-tool overrides). The agent's version does not change with it:
 * a change appends `connectors-changed` and the agent factory rebuilds from the new revision.
 */
export const agentConnectors = sqliteTable(
  'agent_connectors',
  {
    agentId: text('agent_id').notNull(),
    connectionId: text('connection_id').notNull(),
    choices: json<Record<string, unknown>>('choices').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.connectionId] }),
    index('agent_connectors_conn').on(t.connectionId),
  ],
)

/** One DM chat per agent: the sidebar row. */
export const chats = sqliteTable('chats', {
  agentId: text('agent_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  lastMessageAt: integer('last_message_at'),
  lastPreview: text('last_preview'),
  unread: integer('unread').notNull().default(0),
  lastReadMessageId: text('last_read_message_id'),
  /** Events up to this `seq` are read: unread = message events of the agent after it (M4). */
  lastReadSeq: integer('last_read_seq').notNull().default(0),
})

/**
 * The permission mode a person picked for a session (`manual|auto|bypass`, `domain/modes.ts`):
 * the DM chat of an agent today. No row = no pick: the mode follows the agent / workspace default.
 */
export const sessionModes = sqliteTable('session_modes', {
  sessionId: text('session_id').primaryKey(),
  mode: text('mode').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * Connections a person switched off for one chat (the composer tools menu): `off` holds
 * connection ids. No row = nothing off. The tool definitions never change; the agent hides the
 * tools of these connections per step (`activeTools`).
 */
export const chatToolOverrides = sqliteTable('chat_tool_overrides', {
  sessionId: text('session_id').primaryKey(),
  off: json<string[]>('off').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * Index derived from sessions (request R1); the session stays the truth. One row per task session
 * (a child of the lead, later a routine run): written by the `taskIndex` plugin on whichever
 * instance runs the turn, repaired by the boot / periodic drift pass (`infra/eh/team-service.ts`).
 * The `state` column holds the task status (`needs_action|running|done|failed|stopped|interrupted|timed_out`).
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    /** Owner: the agent that runs the task session. */
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull().unique(),
    parentSessionId: text('parent_session_id'),
    origin: text('origin').notNull(),
    title: text('title').notNull(),
    status: text('state').notNull(),
    pendingKind: text('pending_kind'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    summary: text('summary'),
    lastActivityAt: integer('last_activity_at').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
    /** The structured final report of a program run (`{ status, summary, outputs, notes? }`); null otherwise. */
    report: json<{ status: string; summary: string; outputs: string[]; notes?: string }>('report'),
  },
  (t) => [
    index('tasks_state').on(t.status),
    index('tasks_agent').on(t.agentId),
    index('tasks_parent').on(t.parentSessionId),
    index('tasks_activity').on(t.lastActivityAt),
    index('tasks_ended').on(t.endedAt),
  ],
)

/** Append-only feed for the UI (plan §5.3); every instance tails it by `seq`. */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    /** Agent the event concerns (sidebar rows), when there is one. */
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    payload: json<Record<string, unknown>>('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('events_agent').on(t.agentId, t.type, t.seq),
    // sidebar activity (`tasks.activity()`): the last message and the unread assistant messages
    // of an agent without scanning every event or decoding every payload
    index('events_message_agent').on(t.agentId, t.seq).where(sql`${t.type} = 'message-added'`),
    index('events_assistant_agent')
      .on(t.agentId, t.seq)
      .where(
        sql`${t.type} = 'message-added' and json_extract(${t.payload}, '$.role') = 'assistant'`,
      ),
  ],
)

/**
 * Model call log (the Logs page): one row per provider call, written by the `activityLog` plugin
 * (`infra/eh/activity-log.ts`) on whichever instance runs the call. Pruned by count and age. The
 * JSON columns are capped; `truncated` says one of them was cut.
 */
export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at').notNull(),
    kind: text('kind').notNull(),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    turnId: text('turn_id'),
    stepIndex: integer('step_index'),
    messageId: text('message_id'),
    taskId: text('task_id'),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(),
    finishReason: text('finish_reason'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    cachedTokens: integer('cached_tokens'),
    costUsd: real('cost_usd'),
    startedAt: integer('started_at').notNull(),
    firstChunkMs: integer('first_chunk_ms'),
    durationMs: integer('duration_ms').notNull(),
    errorName: text('error_name'),
    errorMessage: text('error_message'),
    requestOptions: text('request_options'),
    requestBody: text('request_body'),
    response: text('response'),
    output: text('output'),
    providerMetadata: text('provider_metadata'),
    usageRaw: text('usage_raw'),
    truncated: integer('truncated').notNull().default(0),
  },
  (t) => [
    index('model_calls_started').on(t.startedAt, t.id),
    index('model_calls_agent').on(t.agentId, t.startedAt),
    index('model_calls_session').on(t.sessionId, t.startedAt),
    index('model_calls_created').on(t.createdAt),
  ],
)

/**
 * Routines (plan §6.6, decision D3): the schedule rows. Every instance ticks; the winner of the
 * compare-and-set on `next_fire_at` fires the slot (`infra/eh/routine-service.ts`). `spec` is
 * `{ kind: 'cron', expr, tz } | { kind: 'every', everyMs } | { kind: 'at', at }`.
 */
export const routines = sqliteTable(
  'routines',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    spec: json<
      | { kind: 'cron'; expr: string; tz: string }
      | { kind: 'every'; everyMs: number }
      | { kind: 'at'; at: number }
    >('spec').notNull(),
    /** `dm` appends the fire to the agent's DM, `task` opens a session `routine:<id>:<at>`. */
    sessionMode: text('session_mode').notNull().default('task'),
    /** `skip` a fire while the previous one still runs, or `queue` it. */
    overlap: text('overlap').notNull().default('skip'),
    /** Missed fires after downtime: null = skip them all, else fire the latest one if it is younger. */
    catchUpWindowMs: integer('catch_up_window_ms'),
    status: text('status').notNull().default('active'),
    pausedReason: text('paused_reason'),
    nextFireAt: integer('next_fire_at'),
    lastFireAt: integer('last_fire_at'),
    lastStatus: text('last_status'),
    /** Consecutive failed runs; the routine pauses itself at `max_failures`. */
    failures: integer('failures').notNull().default(0),
    maxFailures: integer('max_failures').notNull().default(3),
    fireCount: integer('fire_count').notNull().default(0),
    maxFires: integer('max_fires'),
    endAt: integer('end_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Bumped by every edit through the API (not by the ticker): the concurrency token of editors. */
    version: integer('version').notNull().default(1),
    /** Set when a program owns this routine (its schedule trigger); such routines are not listed as routines. */
    programId: text('program_id'),
  },
  (t) => [
    index('routines_due').on(t.status, t.nextFireAt),
    index('routines_agent').on(t.agentId),
    index('routines_program').on(t.programId),
  ],
)

/**
 * Programs (P40 decision D4): a standing order of an agent. A schedule trigger is owned by one row
 * of `routines` (`routines.program_id`); every run is a task session `program:<id>:<runAt>`.
 */
export const programs = sqliteTable(
  'programs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    brief: text('brief').notNull(),
    authority: json<{ tools: string[]; connectors: string[]; read: string[]; write: string[] }>(
      'authority',
    ).notNull(),
    gates: json<string[]>('gates').notNull(),
    escalation: text('escalation').notNull().default(''),
    forbidden: json<string[]>('forbidden').notNull(),
    budget: json<{ perRunUsd: number | null; perDayUsd: number | null }>('budget').notNull(),
    trigger: json<{ kind: 'manual' } | { kind: 'schedule'; spec: Record<string, unknown> }>(
      'trigger',
    ).notNull(),
    /** `digest` | `task` | `silent` */
    report: text('report').notNull().default('task'),
    /** `active` | `paused` */
    status: text('status').notNull().default('active'),
    /** `client`, or the id of the agent that proposed it. */
    createdBy: text('created_by').notNull().default('client'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('programs_agent').on(t.agentId)],
)

/**
 * The Decision Center (P40 decision D5): proposals, escalations and amendments only the client can
 * settle. An escalation or an amendment names the external wait (`wait_id`) its session is parked
 * on; deciding it resolves that wait. Tool approvals are not rows here (they stay in the chat).
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    /** `proposal` | `escalation` | `amendment` */
    kind: text('kind').notNull(),
    /** `open` | `approved` | `rejected` | `expired` */
    status: text('status').notNull().default('open'),
    title: text('title').notNull(),
    /** Markdown: goal, plan steps, why, evidence links. */
    body: text('body').notNull().default(''),
    /** The agent that asks (the owner of the source session). */
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id'),
    programId: text('program_id'),
    /** Kind-specific JSON (`domain/decisions.ts`). */
    payload: json<Record<string, unknown>>('payload').notNull(),
    /** The external wait a parked session waits on (unique: one decision per wait). */
    waitId: text('wait_id'),
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
    decisionNote: text('decision_note'),
    outcome: json<Record<string, unknown>>('outcome'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('decisions_status').on(t.status, t.createdAt),
    index('decisions_agent').on(t.agentId),
    index('decisions_session').on(t.sessionId),
    uniqueIndex('decisions_wait').on(t.waitId),
  ],
)

/** History of fires; the unique `(routine_id, scheduled_at)` makes a slot fire at most once. */
export const routineRuns = sqliteTable(
  'routine_runs',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id').notNull(),
    scheduledAt: integer('scheduled_at').notNull(),
    /** `schedule` | `manual` */
    trigger: text('trigger').notNull(),
    /** `claimed` | `enqueued` | `needs_action` | `succeeded` | `failed` | `skipped` */
    status: text('status').notNull(),
    sessionId: text('session_id').notNull(),
    inboxId: text('inbox_id'),
    reason: text('reason'),
    claimedAt: integer('claimed_at').notNull(),
    firedAt: integer('fired_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    uniqueIndex('routine_runs_slot').on(t.routineId, t.scheduledAt),
    index('routine_runs_inbox').on(t.inboxId),
    index('routine_runs_finished').on(t.finishedAt),
  ],
)

/**
 * Caller ids of inbox items (`session.enqueue(…, { id })`, spec 05 §12 rule 17). `expires_at` is
 * null while the item is stored and `ack time + 24 h` afterwards (the dedupe horizon).
 */
export const ehInboxKeys = sqliteTable(
  'eh_inbox_keys',
  {
    sessionId: text('session_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    itemId: text('item_id').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.dedupeKey] }),
    index('eh_inbox_keys_item').on(t.itemId),
    index('eh_inbox_keys_expiry').on(t.expiresAt),
  ],
)

/** Version history of library files: metadata only (the content is not kept). */
export const libraryHistory = sqliteTable(
  'library_history',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    path: text('path').notNull(),
    /** `write` | `delete` | `move` (path = destination, `from_path` = source) */
    action: text('action').notNull(),
    version: text('version'),
    size: integer('size'),
    fromPath: text('from_path'),
    /** The agent that changed the file; null = a person (the API). */
    agentId: text('agent_id'),
    at: integer('at').notNull(),
  },
  (t) => [index('library_history_path').on(t.path, t.seq), index('library_history_at').on(t.at)],
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

/**
 * Provider profiles (`eharness/providers`, spec 23): one saved connection per row. `settings` is
 * the profile's settings JSON ENCRYPTED with AES-GCM (`infra/eh/secret-box.ts`); every other
 * column is plain. `kind` namespaces profiles (`provider` today, connectors later).
 */
export const configProfiles = sqliteTable(
  'config_profiles',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    definitionId: text('definition_id').notNull(),
    label: text('label').notNull(),
    /** `v1:<keyId>:<iv>:<ciphertext>`: never plaintext. */
    settings: text('settings').notNull(),
    models: json<unknown>('models'),
    /** Plain JSON of the fields beyond the columns (connection scope, status, ...): no secrets. */
    extra: json<Record<string, unknown>>('extra'),
    enabled: integer('enabled').notNull().default(1),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.id] })],
)

/** Connector setup flows (`FlowStore`): `data` is the `FlowState` JSON, its scratch sealed. */
export const connectorFlows = sqliteTable(
  'connector_flows',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash'),
    status: text('status').notNull(),
    expiresAt: integer('expires_at').notNull(),
    data: text('data').notNull(),
  },
  (t) => [
    index('connector_flows_state').on(t.stateHash),
    index('connector_flows_expiry').on(t.expiresAt),
  ],
)

/** Raw public model catalogs (models.dev, OpenRouter) cached between runs (`CatalogCache`). */
export const catalogCache = sqliteTable('catalog_cache', {
  key: text('key').primaryKey(),
  data: text('data').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
})
