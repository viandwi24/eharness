# P58 — Backup coverage: every feature can be backed up and restored

Status: in progress · Owner: agent session · Branch: main

## Goal

Nothing the owner built may exist only in one database file. Every table of the database has an
answer to "how is it backed up, and how does it come back?", and a test proves it: a new table
fails `test/backup-coverage.test.ts` until it is classified here and in
`server/src/domain/backup-coverage.ts`, and `test/backup-everything.test.ts` fills EVERY feature
through the real app, exports, imports into a fresh instance and compares entity by entity.

## The three classes

| Class | Meaning | Tables |
|---|---|---|
| (a) `zip` | Restorable through the workspace zip import (an entity document, rows in `data/<table>/`, the encrypted secrets file, or library files). The database snapshot has it too. | 51 |
| (b) `snapshot` | Covered only by the database snapshot: restore it with "Restore whole database". | 17 |
| (c) `derived` | Derived, cache or ephemeral: nothing to back up (the reason is in the table below). | 20 |

Total: 88 tables (the 86 drizzle tables plus two SQLite
bookkeeping tables).

## The coverage map

### (a) Restorable through the zip

| Table | Feature | Where it travels |
|---|---|---|
| `agent_connectors` | Connector enablement per agent | agents/<slug>/agent.json, key connectors (by connection key) (sections: agents, connections) |
| `agent_persona_proposals` | Persona change proposals | data/agent_persona_proposals (sections: agents) |
| `agent_persona_versions` | Personas and their versions | agents/<slug>/persona.md (latest) and data/agent_persona_versions (history) (sections: agents) |
| `agents` | Agents (including archived) | agents/<slug>/agent.json (archived: true) (sections: agents) |
| `alarms` | Alerts | data/alarms (sections: history) |
| `api_agents` | API agents | data/api_agents (sections: api) |
| `api_calls` | API model call usage | data/api_calls (sections: api) |
| `api_conversations` | API conversations | data/api_conversations (only with "include conversations") (sections: conversations) |
| `api_keys` | API keys (only the hash) | secrets.enc.json only: the hash never travels in plain text (sections: secrets) |
| `api_requests` | API request usage | data/api_requests (sections: api) |
| `artifact_blobs` | Artifact file contents | data/artifact_blobs (sections: artifacts) |
| `artifact_events` | Artifact history | data/artifact_events (sections: artifacts) |
| `artifact_versions` | Artifact versions | data/artifact_versions (sections: artifacts) |
| `artifacts` | Artifacts and their visibility | data/artifacts (share token in the secrets file) (sections: artifacts, secrets) |
| `briefings` | Daily briefings | data/briefings (sections: history) |
| `browser_profiles` | Browser profiles | data/browser_profiles (sections: browser) |
| `ch_identities` | Channel identities | data/ch_identities (sections: channels) |
| `ch_identity_aliases` | Aliases of identities | data/ch_identity_aliases (sections: channels) |
| `ch_identity_profiles` | Nicknames and roles of an identity in a chat | data/ch_identity_profiles (sections: channels) |
| `ch_memberships` | Membership in chats | data/ch_memberships (sections: channels) |
| `ch_node_access` | Access of a connection to a chat | data/ch_node_access (sections: channels) |
| `ch_node_links` | Links between chats and topics | data/ch_node_links (sections: channels) |
| `ch_node_sessions` | The agent session a chat is bound to | data/ch_node_sessions (sections: channels) |
| `ch_node_settings` | Policies of a chat | data/ch_node_settings (sections: channels) |
| `ch_nodes` | Chats and topics of a channel | data/ch_nodes (sections: channels) |
| `ch_people` | People roles in chats | data/ch_people (sections: channels) |
| `ch_people_notes` | Notes about people in chats | data/ch_people_notes (sections: channels) |
| `ch_proactive` | Held proactive posts | data/ch_proactive (sections: channels) |
| `ch_reminders` | Reminders | data/ch_reminders with their schedules in data/routines (restored, not fired twice) (sections: reminders) |
| `channel_connections` | Chat bindings and policies of a channel connection | data/channel_connections (sections: channels) |
| `chat_threads` | Chat threads | data/chat_threads (only with "include conversations") (sections: conversations) |
| `chat_tool_overrides` | Connections a person switched off in a chat | data/chat_tool_overrides (only with "include conversations") (sections: conversations) |
| `chats` | Chat list of the sidebar | data/chats (only with "include conversations") (sections: conversations) |
| `config_profiles` | Model providers and profiles, connections and their credentials, OAuth clients | connections/<label>.json without secrets; the keys and credentials in secrets.enc.json (passphrase) (sections: connections, secrets) |
| `decisions` | Decisions history | data/decisions (sections: history) |
| `eh_messages` | Conversation messages | data/eh_messages (only with "include conversations") (sections: conversations) |
| `eh_state` | Conversation state | data/eh_state (only with "include conversations") (sections: conversations) |
| `library_files` | Library, uploads and memory files (agent memory, HEARTBEAT.md standing orders, notes, ledgers) | library/**, uploads/**, memory/**, agents/<slug>/memory/** (sections: library, memory) |
| `notifications` | Notifications (the bell) | data/notifications (sections: history) |
| `people` | People directory, roles, notes | people/<id>.json (sections: people) |
| `people_accounts` | Platform accounts of people | data/people_accounts (ids of the people are remapped) (sections: people) |
| `people_events` | Directory history of a person | data/people_events (sections: people) |
| `program_tests` | Program tests | data/program_tests (sections: programs) |
| `programs` | Programs (brief, notes, trigger, authority, budget, status) | agents/<slug>/programs/<name>.json and .brief.md; file-mode brief and notes are library files (sections: programs, library) |
| `rehearsals` | Program rehearsals (history) | data/rehearsals (sections: programs) |
| `routines` | Routines, program schedules, reminder schedules | agents/<slug>/routines/<id>.json; reminder schedules in data/routines; heartbeat and digest schedules are rebuilt from the heartbeat configuration (sections: routines, reminders) |
| `session_modes` | Permission mode of a chat | data/session_modes (only with "include conversations") (sections: conversations) |
| `settings` | Workspace settings, heartbeat configuration and state, digest, remembered decisions | settings.json (workspace, heartbeat config, digest config) and data/settings (the rest of the key-value rows) (sections: settings) |
| `tasks` | Tasks and runs (metadata) | data/tasks (sections: history) |
| `tgu_chats` | Telegram account chat selection and backfill state | data/tgu_chats (sections: channels) |
| `tgu_settings` | Telegram account settings | data/tgu_settings (sections: channels) |

### (b) Only in the database snapshot

| Table | Feature | Why |
|---|---|---|
| `ch_events` | Channel event log | sealed with TEAM_CHANNEL_KEY and bound to the ids of the node and message: a copy only reads with the same key |
| `ch_message_revisions` | Edits of channel messages | sealed with TEAM_CHANNEL_KEY and bound to the ids of the node and message: a copy only reads with the same key |
| `ch_messages` | Channel message log | sealed with TEAM_CHANNEL_KEY and bound to the ids of the node and message: a copy only reads with the same key |
| `ch_reactions` | Reactions in channels | sealed with TEAM_CHANNEL_KEY and bound to the ids of the node and message: a copy only reads with the same key |
| `channel_approvals` | Approvals asked in a chat | bound to live sessions and tool calls; the snapshot keeps the record |
| `channel_conversations` | Legacy channel conversations | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_events` | Legacy channel events | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_identities` | Legacy channel identities | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_inbox` | Legacy channel inbox | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_known_chats` | Legacy known chats | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_messages` | Legacy channel messages | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `channel_unlinked` | Legacy unlinked senders | legacy source of the boot-time channels migration; its data lives in the ch_* tables |
| `eh_budget_scope` | Spend counters of budgets | counters of the running period; the budget limits live in the settings and programs |
| `library_history` | File history (who changed which path) | the current files travel in the zip; the history stays in the database snapshot |
| `library_moves` | Moves applied by an import (old path to new path, for the redirects) | a record of what an import renamed; the files themselves travel in the zip at their new paths |
| `model_calls` | Model call log (Logs page) | large diagnostic log with requests and responses, pruned by count and age |
| `routine_runs` | Fired schedule slots | a log of fired slots bound to routine ids; the schedules themselves are restorable |
| `tool_usage` | Tools each agent used recently | usage counters that decide which tools load up front; they refill as agents work |

### (c) Derived, cache or ephemeral

| Table | Feature | Why nothing is backed up |
|---|---|---|
| `__drizzle_migrations` | Schema bookkeeping | written by the migrations of the running app |
| `catalog_cache` | Connector catalog cache | fetched again from the catalog sources when needed |
| `ch_meta` | Channels migration markers | rewritten by the boot-time migration |
| `channel_outbox` | Outgoing message queue | restoring a queue would send old messages again; what was sent is in the channel log |
| `channel_pairing_tokens` | Pairing tokens | one-time tokens that expire in minutes; a restored token would be stale |
| `connector_flows` | Connection setup flows | a sign-in in progress; expires in minutes |
| `eh_budget_record` | Budget records | idempotency keys of recorded spend |
| `eh_budget_reservation` | Budget reservations | held for the length of one model call |
| `eh_inbox` | Session input queue | inputs of turns in flight; stale after a restore |
| `eh_inbox_keys` | Input deduplication keys | expire with the inputs |
| `eh_locks` | Session locks | leases of running instances |
| `eh_stream_chunks` | Stream replay chunks | expires with the stream log |
| `eh_stream_log` | Stream replay log | replays a live stream for a reconnecting client; expires |
| `events` | Change feed of the UI | append-only feed every instance tails; pruned by retention; the sidebar rebuilds from conversations |
| `people_link_codes` | Pairing codes | one-time codes that expire in minutes; a restored code would be stale |
| `sqlite_sequence` | SQLite bookkeeping | counters of AUTOINCREMENT columns |
| `tgu_counters` | Telegram daily counters | flood-protection counters of the current day |
| `tgu_leases` | Telegram account lease | which instance runs the account now; a restored lease would be a stale claim |
| `turn_retries` | Turn retry queue | a retry of a turn in flight; stale after a restore |
| `workspaces` | Workspace row of the first design | never written by any code today (the workspace id is a constant); the settings hold the workspace |

## How the zip carries it

`manifest.json` (format version 2; a version 1 zip is still read) lists every file with its sha256.
Entity documents stay readable (`agents/<slug>/agent.json`, `persona.md`, `programs/*.json` and
`*.brief.md`, `connections/<label>.json`, `people/<id>.json`, library and memory files). Everything
else is rows: `data/<table>/NNN.json` (`{ format: "eharness-team-rows", table, part, rows }`, at
most 2000 rows or about 6 MB per part; a BLOB is `{ "$b64": ... }`). `secrets.enc.json` (AES-256-GCM,
key from the passphrase by PBKDF2-SHA256) holds the provider keys, connection credentials, OAuth
clients, API key hashes and artifact share tokens; nothing secret is ever in plain text in the zip.

Conversations (chat history, `eh_messages` and its siblings) are large and only travel when the
export is made with "include conversations" (default off). Scheduled backups never include them in
the zip (the database snapshot of the same backup always has them).

## The import policy (unchanged, extended)

- Matched by a stable key, ids kept: an agent by slug, a program by name per agent, a routine by id
  then name, a person by id then name, a connection by id then label, a row by its key. New
  entities keep the id they had in the zip when it is free (`createAgent`, `createProgram`,
  `createRoutine` and the people directory accept an id); when the id is taken by something else,
  every reference in the rows is rewritten (`IdMap`).
- An item that exists here and differs is skipped unless the owner chose to overwrite; nothing is
  deleted unless the section is ticked for removal; an undo always overwrites and removes what the
  import added (`removeSections`).
- A verified safety backup is taken before an apply; a restore point records it; the undo is the
  import of that safety backup. A safety backup of an import that touches conversations holds them.
- Connections are created without secrets (status `needs-auth`); the secrets section (passphrase)
  fills them in. An agent's choices about a connection are applied with the connection.
- An agent archived in the zip is created and archived again after what belongs to it is written.
- What belongs to an agent this import created (persona history, ...) is replaced by the rows of the
  zip: the new agent has no history of its own yet.

## Restore whole database

The running server keeps the database file open everywhere, so the file is never swapped under it:

1. Preview: rows per table, backup against live, with the class of each table; the owner types
   `restore whole database`.
2. A verified safety backup of the live database is taken first (nothing happens when it fails).
3. The backup copy is verified again (`PRAGMA integrity_check`; refused when it came from a newer
   schema) and staged as `<db>.restore` with a marker `<db>.restore.json`.
4. A restore point (kind `database-restore`, in the backup directory, so it survives) is recorded.
5. The server exits with code 75 (`Lifecycle.restart`); the process manager starts it again
   (Docker `restart: unless-stopped`, systemd `Restart=always`). Without a process manager the
   owner restarts it by hand; the staged copy is applied at the next start either way.
6. At start, before the database opens, `applyPendingRestore` verifies the staged copy once more,
   moves the old database aside as `<db>.replaced`, deletes the old `-wal` and `-shm`, renames the
   copy into place and writes `<db>.restore.result.json`. A staged copy that fails verification is
   kept as `<db>.restore.failed` and the server starts on the database it had.

Undo is the same operation with the safety backup as the source (`undoOf` set), so an undo can be
undone. Secrets in a database copy are sealed with `TEAM_SECRET_KEY` (and the channel log with
`TEAM_CHANNEL_KEY`): the server must run with the same keys as when the backup was made.

## Proof

- `test/backup-coverage.test.ts`: every table is classified; datasets name real columns and keys.
- `test/backup-everything.test.ts`: every feature populated through the real app, export with a
  passphrase, a fresh empty instance, import with overwrite, entity-by-entity comparison with ids and
  timestamps normalised; a second import changes nothing; the undo restores the exact previous state;
  the whole-database restore round trip and its undo; a restored connection and provider use their
  secret; a restored API key authenticates.
- `test/workspace-export.test.ts`, `test/backups.test.ts`: the pre-existing contracts.

## Open items

- Rows are restored, not replayed: a restored program does not run again, a restored task that
  was running is marked interrupted by the boot repair pass, and channel transports start again
  from the restored bindings only after a restart.
- The people directory's web login link (`people.member_id`) and message logs of channels are not
  in the zip (the logs are sealed with the channel key); they come back with a database restore.
- Removing rows with the "remove what is not in the zip" tick works for every data table; it is
  meant for undo, not for routine use.
