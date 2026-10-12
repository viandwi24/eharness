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
/**
 * Chat threads (`domain/threads.ts`, P40 phase M): the name of a session of a conversation with an
 * agent. The session id of the first thread is the old `dm:<agentId>`; the others are
 * `chat:<agentId>:<id>`. `source` / `source_label` let channel conversations share the list later.
 */
export const chatThreads = sqliteTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    title: text('title'),
    source: text('source').notNull().default('web'),
    sourceLabel: text('source_label'),
    seed: json<{ kind: string; ref: string; title: string }>('seed'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessageAt: integer('last_message_at'),
    preview: text('preview'),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    uniqueIndex('chat_threads_session').on(t.sessionId),
    index('chat_threads_agent').on(t.agentId, t.updatedAt),
  ],
)

/**
 * What the system tells the client outside any chat: urgent heartbeat alerts and "briefing ready"
 * (`app/notifications.ts`). The bell lists the ones not dismissed. `key` makes a notification
 * idempotent (a retried beat or digest adds nothing twice).
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** App path the notification opens (`/tasks/<id>`, `/briefings?id=...`). */
    link: text('link'),
    agentId: text('agent_id'),
    createdAt: integer('created_at').notNull(),
    dismissedAt: integer('dismissed_at'),
  },
  (t) => [
    uniqueIndex('notifications_key').on(t.key),
    index('notifications_open').on(t.dismissedAt, t.createdAt),
  ],
)

/** The daily digest as a page: one row per local day (`app/briefings.ts`). */
export const briefings = sqliteTable(
  'briefings',
  {
    id: text('id').primaryKey(),
    day: text('day').notNull(),
    title: text('title').notNull(),
    /** The digest as markdown (what the lead reads with `read_briefings`). */
    body: text('body').notNull(),
    /** The same content as items, for the page and "Discuss in chat". */
    items:
      json<Array<{ kind: string; title: string; detail: string; link: string | null }>>(
        'items',
      ).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('briefings_day').on(t.day)],
)

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
    /** The deliverable checks of a program run (P40 phase H); null = none to check. */
    deliverables: json<unknown>('deliverables'),
    /** The work queue (P40 D6): the task as the client or the manager wrote it; null for tasks that just happened. */
    brief: text('brief'),
    inputs: json<string[]>('inputs').notNull().default([]),
    /** `low` | `normal` | `high` | `urgent` */
    priority: text('priority').notNull().default('normal'),
    dueAt: integer('due_at'),
    /** `client` or an agent id; null = not a work item. */
    createdBy: text('created_by'),
    acceptedAt: integer('accepted_at'),
    round: integer('round').notNull().default(1),
    /** Sessions of earlier rounds. */
    history: json<string[]>('history').notNull().default([]),
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
    budget: json<{
      perRunUsd: number | null
      perDayUsd: number | null
      maxOutputTokens?: number | null
    }>('budget').notNull(),
    trigger: json<{ kind: 'manual' } | { kind: 'schedule'; spec: Record<string, unknown> }>(
      'trigger',
    ).notNull(),
    /** `digest` | `task` | `silent` */
    report: text('report').notNull().default('task'),
    /** Worker program: `{ maxTasks }` queued tasks per run (P40 D6); null = an ordinary program. */
    worker: json<{ maxTasks: number }>('worker'),
    /** Files a run must leave in the library, checked at run end (P40 phase H); `[]` = none. */
    deliverables: json<unknown[]>('deliverables').notNull().default([]),
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
 * Rehearsals (test runs) of a program (P40 phase K): one row per run with the whole result as JSON
 * (`domain/rehearsal.ts` `Rehearsal`). They are never tasks: not in the run history, the board or
 * the digest. `program_tests` holds the saved test cases of a program (sample inputs, expectations
 * and the last result).
 */
export const rehearsals = sqliteTable(
  'rehearsals',
  {
    id: text('id').primaryKey(),
    programId: text('program_id').notNull(),
    sessionId: text('session_id').notNull(),
    testId: text('test_id'),
    /** `running` | `done` | `failed` */
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    data: json<Record<string, unknown>>('data').notNull(),
  },
  (t) => [
    index('rehearsals_program').on(t.programId, t.startedAt),
    uniqueIndex('rehearsals_session').on(t.sessionId),
  ],
)

export const programTests = sqliteTable(
  'program_tests',
  {
    id: text('id').primaryKey(),
    programId: text('program_id').notNull(),
    name: text('name').notNull(),
    /** `{ sample, expect, lastResult }` (`domain/rehearsal.ts` `TestCase`). */
    data: json<Record<string, unknown>>('data').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('program_tests_program').on(t.programId, t.createdAt)],
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

// --- Channels (docs/plans/P41-team-channels.md, phase L1; `infra/channels`) ---------------------

/** Configuration of a channel connection (policy, binding, limits): JSON, no secrets. */
export const channelConnections = sqliteTable('channel_connections', {
  connectionId: text('connection_id').primaryKey(),
  config: text('config').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * A conversation the gateway woke an agent in: its session, the agent, the reference the adapter
 * gave (JSON) and the label. One session per conversation (`channel:<connection>:<id>`).
 */
export const channelConversations = sqliteTable(
  'channel_conversations',
  {
    connectionId: text('connection_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    ref: text('ref').notNull(),
    label: text('label'),
    /** Days the log keeps this conversation (null = the workspace default). */
    retentionDays: integer('retention_days'),
    createdAt: integer('created_at').notNull(),
    /** Bumped when the agent of the conversation changes: the new agent gets a new session. */
    generation: integer('generation').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.conversationId] }),
    uniqueIndex('channel_conversations_session').on(t.sessionId),
  ],
)

/**
 * The outbox (P41 hardening): every message the gateway sends is a row before it is sent.
 * `kind`: `reply` (final text of a turn), `post` (a tool call), `approval` (a request for an
 * answer). `status`: `pending` -> `sending` (claimed) -> `sent` | `failed` | `skipped`. `body` is
 * sealed with the channel vault (text, quote, buttons). A row is posted at most once: it is
 * claimed with a compare-and-set and carries its own id to the adapter as the idempotency key.
 */
export const channelOutbox = sqliteTable(
  'channel_outbox',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    sessionId: text('session_id'),
    kind: text('kind').notNull(),
    /** Platform id of the message that woke the agent (replies, approvals). */
    triggerId: text('trigger_id'),
    chunkIndex: integer('chunk_index').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(1),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAt: integer('next_at').notNull().default(0),
    lastError: text('last_error'),
    platformId: text('platform_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    sentAt: integer('sent_at'),
  },
  (t) => [
    index('channel_outbox_due').on(t.connectionId, t.status, t.createdAt),
    index('channel_outbox_trigger').on(t.connectionId, t.conversationId, t.kind, t.triggerId),
  ],
)

/**
 * An approval or question of a channel turn that was announced in the conversation. `status`:
 * `open` -> `answered` (from the channel by `answeredBy`, or elsewhere = the web). `consumed`:
 * the turn that raised it finished (its reply was queued).
 */
export const channelApprovals = sqliteTable(
  'channel_approvals',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** `approvalId` or `toolCallId` of the pending item. */
    itemId: text('item_id').notNull(),
    itemKind: text('item_kind').notNull(),
    toolName: text('tool_name').notNull(),
    triggerId: text('trigger_id'),
    /** Platform account that wrote the trigger, and the team member it is linked to (when it is). */
    requesterPeer: text('requester_peer'),
    requesterMember: text('requester_member'),
    status: text('status').notNull().default('open'),
    answeredBy: text('answered_by'),
    outcome: text('outcome'),
    /** Platform id of the request message, once it was sent. */
    messageId: text('message_id'),
    consumed: integer('consumed').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
  },
  (t) => [
    uniqueIndex('channel_approvals_item').on(t.sessionId, t.itemId),
    index('channel_approvals_session').on(t.sessionId, t.status),
  ],
)

/**
 * The channel log: normalized messages of allowed conversations. `body` is sealed with the
 * channel vault (its own key). `pending` = observed and not yet shown to a run; `handled` = the
 * gateway finished acting on it (a redelivery of an unhandled one repeats the action).
 */
export const channelMessages = sqliteTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    platformId: text('platform_id').notNull(),
    at: integer('at').notNull(),
    self: integer('self').notNull().default(0),
    pending: integer('pending').notNull().default(0),
    handled: integer('handled').notNull().default(0),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    /** Change counter (insert, edit, delete): the cursor of collectors (`channels/store.ts`). */
    rev: integer('rev').notNull().default(0),
    /** What the gateway did with an incoming message: `woke` the agent or `observed` it (null = sent by us, or older rows). */
    disposition: text('disposition'),
    body: text('body').notNull(),
  },
  (t) => [
    uniqueIndex('channel_messages_platform').on(t.connectionId, t.conversationId, t.platformId),
    index('channel_messages_rev').on(t.connectionId, t.rev),
    index('channel_messages_conversation').on(t.connectionId, t.conversationId, t.id),
    index('channel_messages_at').on(t.at),
  ],
)

/** Platform user to team member (set by a pairing token). */
export const channelIdentities = sqliteTable(
  'channel_identities',
  {
    connectionId: text('connection_id').notNull(),
    peerId: text('peer_id').notNull(),
    memberId: text('member_id').notNull(),
    name: text('name'),
    linkedAt: integer('linked_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.peerId] }),
    index('channel_identities_member').on(t.connectionId, t.memberId),
  ],
)

/**
 * People who wrote to a connection and are not linked to a team member (P41 inbox). Metadata only:
 * no message text is stored for them. `ignored` hides the row from "Not linked yet".
 */
export const channelUnlinked = sqliteTable(
  'channel_unlinked',
  {
    connectionId: text('connection_id').notNull(),
    peerId: text('peer_id').notNull(),
    name: text('name'),
    username: text('username'),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    ignored: integer('ignored').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.peerId] })],
)

/**
 * One row per conversation a connection has seen (inbox list): the reference the adapter gave and
 * counters of what the gateway did with its messages. Metadata only; the text is in the sealed log.
 */
export const channelInbox = sqliteTable(
  'channel_inbox',
  {
    connectionId: text('connection_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    ref: text('ref').notNull(),
    woke: integer('woke').notNull().default(0),
    observed: integer('observed').notNull().default(0),
    dropped: integer('dropped').notNull().default(0),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.conversationId] }),
    index('channel_inbox_last').on(t.connectionId, t.lastAt),
  ],
)

/**
 * The activity of a connection: what happened to each message and each outgoing message (woke,
 * observed, dropped with a reason, reply queued/sent/retried/failed, approvals, breaker,
 * needs-auth). Metadata only: never a message text. Pruned by age and count.
 */
export const channelEvents = sqliteTable(
  'channel_events',
  {
    /** uuidv7: sorts by time, the paging cursor. */
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    at: integer('at').notNull(),
    type: text('type').notNull(),
    reason: text('reason'),
    conversationId: text('conversation_id'),
    peerId: text('peer_id'),
    peerName: text('peer_name'),
    platformId: text('platform_id'),
    detail: text('detail'),
  },
  (t) => [
    index('channel_events_conn').on(t.connectionId, t.id),
    index('channel_events_type').on(t.connectionId, t.type, t.id),
    index('channel_events_conversation').on(t.connectionId, t.conversationId, t.id),
    index('channel_events_at').on(t.at),
  ],
)

/** One-time pairing tokens (only the hash is stored). */
export const channelPairingTokens = sqliteTable(
  'channel_pairing_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    connectionId: text('connection_id').notNull(),
    memberId: text('member_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('channel_pairing_expiry').on(t.expiresAt)],
)

/**
 * Chats a bot connection has seen (any update from a group, supergroup or channel, or a change of
 * the bot's own membership), so an admin can pick which ones the agent may use. `topics` is a JSON
 * object of forum topic id to name. Not the channel log: it holds no message text.
 */
export const channelKnownChats = sqliteTable(
  'channel_known_chats',
  {
    connectionId: text('connection_id').notNull(),
    chatId: text('chat_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    username: text('username'),
    forum: integer('forum').notNull().default(0),
    topics: text('topics').notNull().default('{}'),
    botStatus: text('bot_status'),
    canPost: integer('can_post'),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.chatId] })],
)

/**
 * Chats of a Telegram user account (P41 L4, `infra/telegram-user`): what the account is in, which
 * ones were chosen for ingest, and the state of their backfill and admin-log jobs. No message text.
 */
export const tguChats = sqliteTable(
  'tgu_chats',
  {
    connectionId: text('connection_id').notNull(),
    chatId: text('chat_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    username: text('username'),
    forum: integer('forum').notNull().default(0),
    /** The account is an admin (or the creator) there: the admin log can be read. */
    admin: integer('admin').notNull().default(0),
    selected: integer('selected').notNull().default(0),
    /** Highest message id stored (live, backfill or gap fill): the gap fill after downtime starts here. */
    highId: integer('high_id'),
    /** Lowest id seen live: backfill walks below it. */
    firstLiveId: integer('first_live_id'),
    backfillDays: integer('backfill_days'),
    /** idle | queued | running | parked | done | error */
    backfillState: text('backfill_state').notNull().default('idle'),
    /** Lowest message id the backfill reached (the resume cursor). */
    backfillOldestId: integer('backfill_oldest_id'),
    backfillOldestAt: integer('backfill_oldest_at'),
    backfillCount: integer('backfill_count').notNull().default(0),
    backfillError: text('backfill_error'),
    /** A flood wait: the chat's jobs resume at this time (epoch ms). */
    parkedUntil: integer('parked_until'),
    adminLogEnabled: integer('admin_log_enabled').notNull().default(0),
    adminLogLastId: text('admin_log_last_id'),
    adminLogLastAt: integer('admin_log_last_at'),
    adminLogCount: integer('admin_log_count').notNull().default(0),
    adminLogError: text('admin_log_error'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.chatId] })],
)

/** One live client per session: the holder and when its claim lapses (AUTH_KEY_DUPLICATED protection). */
export const tguLeases = sqliteTable('tgu_leases', {
  connectionId: text('connection_id').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

/** Per-day counters of what the account sent (daily caps): `key` is `dm` or `all`. */
export const tguCounters = sqliteTable(
  'tgu_counters',
  {
    connectionId: text('connection_id').notNull(),
    day: text('day').notNull(),
    key: text('key').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.day, t.key] })],
)

/** Account-level settings of a user connection (limits, admin-log interval). JSON, no secrets. */
export const tguSettings = sqliteTable('tgu_settings', {
  connectionId: text('connection_id').primaryKey(),
  config: text('config').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// --- Generic conversation model (docs/plans/P41-team-channels.md, phase L5; `infra/channels`) ---
//
// One storage model for every platform: nodes (a tree of places), their links and per-connection
// access, inherited settings, identities, messages with revisions and tombstones, reactions, an
// append-only event log and the session bound to a node. The `channel_conversations`,
// `channel_messages`, `channel_inbox`, `channel_events`, `channel_known_chats`, `channel_unlinked`,
// `channel_identities`, `channel_pairing_tokens` and `tgu_chats` tables above are LEGACY: nothing
// reads them after the boot-time data migration (`infra/channels/legacy-migration.ts`) copied them
// here. They stay for one release so a bad migration is recoverable, then a later migration drops them.
// `channel_outbox` and `channel_approvals` stay; their `conversation_id` column now holds a node id.

/** Small key/value facts about the channel storage (migration markers). */
export const chMeta = sqliteTable('ch_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * A place: a tree with a materialized `path` (`/<root id>/.../<id>`). `kind` and `traits` are the
 * structure core logic may branch on; `platformType` is display and debugging only. `meta` is JSON
 * validated by the adapter. `nativeId` is composed by the adapter and opaque to the core.
 * `legacyRefId` is the conversation id of before L5, so old sessions and logs map without rewriting.
 */
export const chNodes = sqliteTable(
  'ch_nodes',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    nativeId: text('native_id').notNull(),
    parentId: text('parent_id'),
    path: text('path').notNull(),
    /** `space` | `room` | `thread` | `direct`. */
    kind: text('kind').notNull(),
    /** JSON `NodeTraits` (multiUser, broadcast, container, threading, postable, ephemeral, external, threadsOnly). */
    traits: text('traits').notNull(),
    platformType: text('platform_type').notNull().default(''),
    /** A node created from a message (a Discord thread, a forum topic's first message). */
    originMessageNativeId: text('origin_message_native_id'),
    title: text('title'),
    /** `active` | `closed` | `archived` | `deleted` | `left`. */
    state: text('state').notNull().default('active'),
    stateReason: text('state_reason'),
    meta: text('meta').notNull().default('{}'),
    metaVersion: integer('meta_version').notNull().default(0),
    legacyRefId: text('legacy_ref_id'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastEventAt: integer('last_event_at').notNull(),
  },
  (t) => [
    uniqueIndex('ch_nodes_native').on(t.connectionId, t.nativeId),
    uniqueIndex('ch_nodes_legacy').on(t.connectionId, t.legacyRefId),
    index('ch_nodes_parent').on(t.parentId),
    index('ch_nodes_path').on(t.connectionId, t.path),
  ],
)

/** Relations that are not parent and child: `discussion_of`, `monoforum_of`, `follows`, `alias_of`, `migrated_from`. */
export const chNodeLinks = sqliteTable(
  'ch_node_links',
  {
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    rel: text('rel').notNull(),
    meta: text('meta').notNull().default('{}'),
  },
  (t) => [
    primaryKey({ columns: [t.fromNodeId, t.toNodeId, t.rel] }),
    index('ch_node_links_to').on(t.toNodeId, t.rel),
  ],
)

/**
 * What the connection is in a node (a node belongs to one connection): membership, whether it may
 * post or read, the read marker, `history` (backfill bookkeeping, JSON) and `extra` (adapter-private
 * per-node job state, JSON).
 */
export const chNodeAccess = sqliteTable('ch_node_access', {
  nodeId: text('node_id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  /** `member` | `admin` | `owner` | `none` | `unknown`. */
  member: text('member').notNull().default('unknown'),
  canPost: integer('can_post'),
  canRead: integer('can_read'),
  muted: integer('muted').notNull().default(0),
  lastReadNativeId: text('last_read_native_id'),
  history: text('history').notNull().default('{}'),
  extra: text('extra').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull(),
})

/** Settings that inherit down the tree: node, ancestors, the connection's defaults, the product's. */
export const chNodeSettings = sqliteTable(
  'ch_node_settings',
  {
    nodeId: text('node_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.key] })],
)

/**
 * A person, bot or channel as one connection sees it. `personId` is the team member the identity
 * is linked to (set only by an authorized action, never merged automatically). `dm_*` count the
 * direct messages of an identity that is not linked (the "Not linked yet" list): metadata only.
 */
export const chIdentities = sqliteTable(
  'ch_identities',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    nativeId: text('native_id').notNull(),
    /** `human` | `bot` | `app` | `channel` | `webhook` | `system` | `anonymous`. */
    kind: text('kind').notNull().default('human'),
    personId: text('person_id'),
    linkedAt: integer('linked_at'),
    isSelf: integer('is_self').notNull().default(0),
    displayName: text('display_name'),
    username: text('username'),
    avatar: text('avatar'),
    meta: text('meta').notNull().default('{}'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    dmFirstAt: integer('dm_first_at'),
    dmLastAt: integer('dm_last_at'),
    dmCount: integer('dm_count').notNull().default(0),
    ignored: integer('ignored').notNull().default(0),
  },
  (t) => [
    uniqueIndex('ch_identities_native').on(t.connectionId, t.nativeId),
    index('ch_identities_person').on(t.connectionId, t.personId),
  ],
)

/** Ids that change or repeat a person: a username, a phone, a LID. */
export const chIdentityAliases = sqliteTable(
  'ch_identity_aliases',
  {
    identityId: text('identity_id').notNull(),
    connectionId: text('connection_id').notNull(),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.identityId, t.kind, t.value] }),
    index('ch_identity_aliases_value').on(t.connectionId, t.kind, t.value),
  ],
)

/** A guild nickname, a workspace display name, a custom admin title: per space or room. */
export const chIdentityProfiles = sqliteTable(
  'ch_identity_profiles',
  {
    identityId: text('identity_id').notNull(),
    scopeNodeId: text('scope_node_id').notNull(),
    nick: text('nick'),
    avatar: text('avatar'),
    roles: text('roles').notNull().default('[]'),
    meta: text('meta').notNull().default('{}'),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.scopeNodeId] })],
)

export const chMemberships = sqliteTable(
  'ch_memberships',
  {
    nodeId: text('node_id').notNull(),
    identityId: text('identity_id').notNull(),
    role: text('role').notNull().default('member'),
    joinedAt: integer('joined_at'),
    leftAt: integer('left_at'),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.identityId] })],
)

/**
 * Messages, keyed by `(node, native id)`. `content` is sealed with the channel vault (UIMessage
 * compatible parts and entities; null once redacted). A deleted message stays as a tombstone
 * (`deleted_at`): replies and thread roots still resolve. `rev` is the change counter collectors
 * follow. `pending` = observed and not yet shown to a run; `handled` = the gateway finished
 * acting on it (a redelivery of an unhandled one repeats the action).
 */
export const chMessages = sqliteTable(
  'ch_messages',
  {
    /** uuidv7: sorts by creation. */
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    nodeId: text('node_id').notNull(),
    nativeId: text('native_id').notNull(),
    senderIdentityId: text('sender_identity_id'),
    /** Platform time (epoch ms). */
    sentAt: integer('sent_at').notNull(),
    sortKey: text('sort_key').notNull().default(''),
    /** `in` | `out`. */
    direction: text('direction').notNull().default('in'),
    /** `message` | `service` | `system`. */
    kind: text('kind').notNull().default('message'),
    content: text('content'),
    contentVersion: integer('content_version').notNull().default(0),
    replyToNativeId: text('reply_to_native_id'),
    replyToMessageId: text('reply_to_message_id'),
    threadRootNativeId: text('thread_root_native_id'),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    deletedBy: text('deleted_by'),
    deletedHasContent: integer('deleted_has_content').notNull().default(0),
    sendTxnId: text('send_txn_id'),
    /** What the gateway did with an incoming message: `woke` or `observed` (null = sent by us). */
    disposition: text('disposition'),
    pending: integer('pending').notNull().default(0),
    handled: integer('handled').notNull().default(0),
    rev: integer('rev').notNull().default(0),
    meta: text('meta').notNull().default('{}'),
  },
  (t) => [
    uniqueIndex('ch_messages_native').on(t.nodeId, t.nativeId),
    uniqueIndex('ch_messages_txn').on(t.nodeId, t.sendTxnId).where(sql`${t.sendTxnId} IS NOT NULL`),
    index('ch_messages_rev').on(t.connectionId, t.rev),
    index('ch_messages_node').on(t.nodeId, t.id),
    index('ch_messages_native_any').on(t.connectionId, t.nativeId),
    index('ch_messages_sent').on(t.sentAt),
  ],
)

/** Earlier versions of an edited message (content sealed like the message). */
export const chMessageRevisions = sqliteTable(
  'ch_message_revisions',
  {
    messageId: text('message_id').notNull(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    editedAt: integer('edited_at').notNull(),
    editorIdentityId: text('editor_identity_id'),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.version] })],
)

export const chReactions = sqliteTable(
  'ch_reactions',
  {
    messageId: text('message_id').notNull(),
    identityId: text('identity_id').notNull(),
    emojiId: text('emoji_id').notNull(),
    emoji: text('emoji').notNull(),
    at: integer('at').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.identityId, t.emojiId] })],
)

/**
 * The append-only event log: what the platform said (`message.created`, `node.updated`, ...) and
 * what the gateway did with it (`gateway.woke`, `gateway.dropped`, `gateway.reply_sent`, ...).
 * Unique `(connection, dedupe key)`; `node_id` is null while an event cannot be placed (a deletion
 * without a chat id). `payload` holds facts, never a message text; `raw` (optional, prunable,
 * sealed) the platform payload so events can be re-normalized with a newer `normalizer_version`.
 */
export const chEvents = sqliteTable(
  'ch_events',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    type: text('type').notNull(),
    nodeId: text('node_id'),
    actorIdentityId: text('actor_identity_id'),
    targetMessageNativeId: text('target_message_native_id'),
    targetMessageId: text('target_message_id'),
    at: integer('at').notNull(),
    receivedAt: integer('received_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    streamOrder: text('stream_order'),
    normalizerVersion: integer('normalizer_version').notNull().default(1),
    payload: text('payload').notNull().default('{}'),
    raw: text('raw'),
  },
  (t) => [
    uniqueIndex('ch_events_dedupe').on(t.connectionId, t.dedupeKey),
    index('ch_events_conn').on(t.connectionId, t.id),
    index('ch_events_type').on(t.connectionId, t.type, t.id),
    index('ch_events_node').on(t.connectionId, t.nodeId, t.id),
    index('ch_events_at').on(t.at),
  ],
)

/**
 * The session of an agent for a node (or for the room a node shares its session with): the agent,
 * the generation (bumped when the agent of the node changes) and the thread label.
 * `session_id` is `channel:<connection>:<node id>[#generation]`, or the old key for nodes migrated
 * from L1-L4.
 */
export const chNodeSessions = sqliteTable(
  'ch_node_sessions',
  {
    connectionId: text('connection_id').notNull(),
    nodeId: text('node_id').notNull(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    label: text('label'),
    createdAt: integer('created_at').notNull(),
    generation: integer('generation').notNull().default(0),
    /** The node the session answered in last (the default target of its tools when it shares a room). */
    lastNodeId: text('last_node_id'),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.nodeId] }),
    uniqueIndex('ch_node_sessions_session').on(t.sessionId),
  ],
)
