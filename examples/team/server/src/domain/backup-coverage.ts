/**
 * The backup coverage map: every table of the database, classified. `test/backup-coverage.test.ts`
 * fails when a table exists that is not listed here (or listed and gone), so a new feature cannot
 * ship without an answer to "how is it backed up and restored?". The same map is written out in
 * `docs/plans/P58-backup-coverage.md`.
 *
 *  - `zip`      restorable through the workspace zip import (an entity document, a data table, the
 *               encrypted secrets file, or library files). The database snapshot has it too.
 *  - `snapshot` covered only by the database snapshot: restore it with "Restore whole database".
 *  - `derived`  derived, cache or ephemeral: nothing to back up (the `why` says what rebuilds it or
 *               why restoring it would be harmful).
 */
import { DATASET_BY_TABLE, type SectionId } from './workspace-data.ts'

export type TableClass = 'zip' | 'snapshot' | 'derived'

export interface TableEntry {
  table: string
  class: TableClass
  /** What the owner sees: the feature the table belongs to. */
  feature: string
  /** `zip`: where it travels in the zip. `snapshot` and `derived`: why it does not. */
  note: string
  /** The sections that restore it (class `zip`). */
  sections?: readonly SectionId[]
}

const zip = (
  table: string,
  feature: string,
  note: string,
  sections: readonly SectionId[],
): TableEntry => ({ table, class: 'zip', feature, note, sections })
const snapshot = (table: string, feature: string, note: string): TableEntry => ({
  table,
  class: 'snapshot',
  feature,
  note,
})
const derived = (table: string, feature: string, note: string): TableEntry => ({
  table,
  class: 'derived',
  feature,
  note,
})

const CHANNEL_KEY =
  'sealed with TEAM_CHANNEL_KEY and bound to the ids of the node and message: a copy only reads with the same key'
const LEGACY_CHANNELS =
  'legacy source of the boot-time channels migration; its data lives in the ch_* tables'

export const COVERAGE: readonly TableEntry[] = [
  // agents
  zip('agents', 'Agents (including archived)', 'agents/<slug>/agent.json (archived: true)', [
    'agents',
  ]),
  zip(
    'agent_connectors',
    'Connector enablement per agent',
    'agents/<slug>/agent.json, key connectors (by connection key)',
    ['agents', 'connections'],
  ),
  zip(
    'agent_persona_versions',
    'Personas and their versions',
    'agents/<slug>/persona.md (latest) and data/agent_persona_versions (history)',
    ['agents'],
  ),
  zip('agent_persona_proposals', 'Persona change proposals', 'data/agent_persona_proposals', [
    'agents',
  ]),
  // programs and routines
  zip(
    'programs',
    'Programs (brief, notes, trigger, authority, budget, status)',
    'agents/<slug>/programs/<name>.json and .brief.md; file-mode brief and notes are library files',
    ['programs', 'library'],
  ),
  zip('program_tests', 'Program tests', 'data/program_tests', ['programs']),
  zip('rehearsals', 'Program rehearsals (history)', 'data/rehearsals', ['programs']),
  zip(
    'routines',
    'Routines, program schedules, reminder schedules',
    'agents/<slug>/routines/<id>.json; reminder schedules in data/routines; heartbeat and digest schedules are rebuilt from the heartbeat configuration',
    ['routines', 'reminders'],
  ),
  snapshot(
    'routine_runs',
    'Fired schedule slots',
    'a log of fired slots bound to routine ids; the schedules themselves are restorable',
  ),
  // settings
  zip(
    'settings',
    'Workspace settings, heartbeat configuration and state, digest, remembered decisions',
    'settings.json (workspace, heartbeat config, digest config) and data/settings (the rest of the key-value rows)',
    ['settings'],
  ),
  // models and connections
  zip(
    'config_profiles',
    'Model providers and profiles, connections and their credentials, OAuth clients',
    'connections/<label>.json without secrets; the keys and credentials in secrets.enc.json (passphrase)',
    ['connections', 'secrets'],
  ),
  derived('connector_flows', 'Connection setup flows', 'a sign-in in progress; expires in minutes'),
  derived(
    'catalog_cache',
    'Connector catalog cache',
    'fetched again from the catalog sources when needed',
  ),
  // memory and files
  zip(
    'library_files',
    'Library, uploads and memory files (agent memory, HEARTBEAT.md standing orders, notes, ledgers)',
    'library/**, uploads/**, memory/**, agents/<slug>/memory/**',
    ['library', 'memory'],
  ),
  snapshot(
    'library_history',
    'File history (who changed which path)',
    'the current files travel in the zip; the history stays in the database snapshot',
  ),
  snapshot(
    'library_moves',
    'Moves applied by an import (old path to new path, for the redirects)',
    'a record of what an import renamed; the files themselves travel in the zip at their new paths',
  ),
  // people
  zip('people', 'People directory, roles, notes', 'people/<id>.json', ['people']),
  zip(
    'people_accounts',
    'Platform accounts of people',
    'data/people_accounts (ids of the people are remapped)',
    ['people'],
  ),
  zip('people_events', 'Directory history of a person', 'data/people_events', ['people']),
  derived(
    'people_link_codes',
    'Pairing codes',
    'one-time codes that expire in minutes; a restored code would be stale',
  ),
  // decisions, tasks, alerts
  zip('decisions', 'Decisions history', 'data/decisions', ['history']),
  zip('tasks', 'Tasks and runs (metadata)', 'data/tasks', ['history']),
  zip('alarms', 'Alerts', 'data/alarms', ['history']),
  zip('notifications', 'Notifications (the bell)', 'data/notifications', ['history']),
  zip('briefings', 'Daily briefings', 'data/briefings', ['history']),
  // conversations
  zip('chats', 'Chat list of the sidebar', 'data/chats (only with "include conversations")', [
    'conversations',
  ]),
  zip('chat_threads', 'Chat threads', 'data/chat_threads (only with "include conversations")', [
    'conversations',
  ]),
  zip(
    'session_modes',
    'Permission mode of a chat',
    'data/session_modes (only with "include conversations")',
    ['conversations'],
  ),
  zip(
    'chat_tool_overrides',
    'Connections a person switched off in a chat',
    'data/chat_tool_overrides (only with "include conversations")',
    ['conversations'],
  ),
  zip(
    'eh_messages',
    'Conversation messages',
    'data/eh_messages (only with "include conversations")',
    ['conversations'],
  ),
  zip('eh_state', 'Conversation state', 'data/eh_state (only with "include conversations")', [
    'conversations',
  ]),
  // channels
  zip(
    'channel_connections',
    'Chat bindings and policies of a channel connection',
    'data/channel_connections',
    ['channels'],
  ),
  zip('tgu_settings', 'Telegram account settings', 'data/tgu_settings', ['channels']),
  zip('tgu_chats', 'Telegram account chat selection and backfill state', 'data/tgu_chats', [
    'channels',
  ]),
  zip('ch_nodes', 'Chats and topics of a channel', 'data/ch_nodes', ['channels']),
  zip('ch_node_links', 'Links between chats and topics', 'data/ch_node_links', ['channels']),
  zip('ch_node_access', 'Access of a connection to a chat', 'data/ch_node_access', ['channels']),
  zip('ch_node_settings', 'Policies of a chat', 'data/ch_node_settings', ['channels']),
  zip('ch_identities', 'Channel identities', 'data/ch_identities', ['channels']),
  zip('ch_identity_aliases', 'Aliases of identities', 'data/ch_identity_aliases', ['channels']),
  zip(
    'ch_identity_profiles',
    'Nicknames and roles of an identity in a chat',
    'data/ch_identity_profiles',
    ['channels'],
  ),
  zip('ch_memberships', 'Membership in chats', 'data/ch_memberships', ['channels']),
  zip('ch_node_sessions', 'The agent session a chat is bound to', 'data/ch_node_sessions', [
    'channels',
  ]),
  zip('ch_people', 'People roles in chats', 'data/ch_people', ['channels']),
  zip('ch_people_notes', 'Notes about people in chats', 'data/ch_people_notes', ['channels']),
  zip('ch_proactive', 'Held proactive posts', 'data/ch_proactive', ['channels']),
  zip(
    'ch_reminders',
    'Reminders',
    'data/ch_reminders with their schedules in data/routines (restored, not fired twice)',
    ['reminders'],
  ),
  snapshot('ch_messages', 'Channel message log', CHANNEL_KEY),
  snapshot('ch_message_revisions', 'Edits of channel messages', CHANNEL_KEY),
  snapshot('ch_reactions', 'Reactions in channels', CHANNEL_KEY),
  snapshot('ch_events', 'Channel event log', CHANNEL_KEY),
  snapshot(
    'ch_join_requests',
    'Join requests of chats that need approval',
    'a list of who asked to join and how it ended; the platform keeps the live pending list',
  ),
  snapshot(
    'triggers',
    'Triggers (event listeners) and their sealed webhook secrets',
    'bound to connection, chat and program ids and sealed with TEAM_SECRET_KEY; restore with the whole database',
  ),
  snapshot('trigger_fires', 'Firing log of the triggers', 'a log of what each trigger did'),
  derived('ch_meta', 'Channels migration markers', 'rewritten by the boot-time migration'),
  snapshot(
    'channel_approvals',
    'Approvals asked in a chat',
    'bound to live sessions and tool calls; the snapshot keeps the record',
  ),
  derived(
    'channel_outbox',
    'Outgoing message queue',
    'restoring a queue would send old messages again; what was sent is in the channel log',
  ),
  snapshot('channel_conversations', 'Legacy channel conversations', LEGACY_CHANNELS),
  snapshot('channel_messages', 'Legacy channel messages', LEGACY_CHANNELS),
  snapshot('channel_identities', 'Legacy channel identities', LEGACY_CHANNELS),
  snapshot('channel_unlinked', 'Legacy unlinked senders', LEGACY_CHANNELS),
  snapshot('channel_inbox', 'Legacy channel inbox', LEGACY_CHANNELS),
  snapshot('channel_events', 'Legacy channel events', LEGACY_CHANNELS),
  snapshot('channel_known_chats', 'Legacy known chats', LEGACY_CHANNELS),
  derived(
    'channel_pairing_tokens',
    'Pairing tokens',
    'one-time tokens that expire in minutes; a restored token would be stale',
  ),
  derived(
    'tgu_leases',
    'Telegram account lease',
    'which instance runs the account now; a restored lease would be a stale claim',
  ),
  derived(
    'tgu_counters',
    'Telegram daily counters',
    'flood-protection counters of the current day',
  ),
  // artifacts
  zip(
    'artifacts',
    'Artifacts and their visibility',
    'data/artifacts (share token in the secrets file)',
    ['artifacts', 'secrets'],
  ),
  zip('artifact_versions', 'Artifact versions', 'data/artifact_versions', ['artifacts']),
  zip('artifact_blobs', 'Artifact file contents', 'data/artifact_blobs', ['artifacts']),
  zip('artifact_events', 'Artifact history', 'data/artifact_events', ['artifacts']),
  // developer API
  zip('api_agents', 'API agents', 'data/api_agents', ['api']),
  zip(
    'api_keys',
    'API keys (only the hash)',
    'secrets.enc.json only: the hash never travels in plain text',
    ['secrets'],
  ),
  zip(
    'api_conversations',
    'API conversations',
    'data/api_conversations (only with "include conversations")',
    ['conversations'],
  ),
  zip('api_requests', 'API request usage', 'data/api_requests', ['api']),
  zip('api_calls', 'API model call usage', 'data/api_calls', ['api']),
  // browser
  zip('browser_profiles', 'Browser profiles', 'data/browser_profiles', ['browser']),
  // logs and counters
  snapshot(
    'model_calls',
    'Model call log (Logs page)',
    'large diagnostic log with requests and responses, pruned by count and age',
  ),
  snapshot(
    'tool_usage',
    'Tools each agent used recently',
    'usage counters that decide which tools load up front; they refill as agents work',
  ),
  snapshot(
    'eh_budget_scope',
    'Spend counters of budgets',
    'counters of the running period; the budget limits live in the settings and programs',
  ),
  derived('eh_budget_reservation', 'Budget reservations', 'held for the length of one model call'),
  derived('eh_budget_record', 'Budget records', 'idempotency keys of recorded spend'),
  derived(
    'events',
    'Change feed of the UI',
    'append-only feed every instance tails; pruned by retention; the sidebar rebuilds from conversations',
  ),
  // runtime
  derived('turn_retries', 'Turn retry queue', 'a retry of a turn in flight; stale after a restore'),
  derived('eh_inbox', 'Session input queue', 'inputs of turns in flight; stale after a restore'),
  derived('eh_inbox_keys', 'Input deduplication keys', 'expire with the inputs'),
  derived('eh_locks', 'Session locks', 'leases of running instances'),
  derived(
    'eh_stream_log',
    'Stream replay log',
    'replays a live stream for a reconnecting client; expires',
  ),
  derived('eh_stream_chunks', 'Stream replay chunks', 'expires with the stream log'),
  derived(
    'workspaces',
    'Workspace row of the first design',
    'never written by any code today (the workspace id is a constant); the settings hold the workspace',
  ),
  derived(
    '__drizzle_migrations',
    'Schema bookkeeping',
    'written by the migrations of the running app',
  ),
  derived('sqlite_sequence', 'SQLite bookkeeping', 'counters of AUTOINCREMENT columns'),
]

export const COVERAGE_BY_TABLE: ReadonlyMap<string, TableEntry> = new Map(
  COVERAGE.map((e) => [e.table, e]),
)

/** Tables in class `zip` that are restored as plain rows (the others have an entity document or a secrets record). */
export const isDataset = (table: string): boolean => DATASET_BY_TABLE.has(table)

export const coverageCounts = (): Record<TableClass, number> => ({
  zip: COVERAGE.filter((e) => e.class === 'zip').length,
  snapshot: COVERAGE.filter((e) => e.class === 'snapshot').length,
  derived: COVERAGE.filter((e) => e.class === 'derived').length,
})
