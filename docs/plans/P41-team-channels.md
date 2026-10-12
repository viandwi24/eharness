# P41 — Team example: channels (chat platforms as sessions of an agent)

Status: todo · Owner: maintainer · Branch: `main` (batched, see release workflow)

## Goal

Agents of the team example live in chat platforms the way employees do. A **channel connection**
(one platform identity: a Telegram bot, a Telegram user account, later a Discord or Slack app) is
bound to an agent. Messages from allowlisted chats either **wake** the agent (mention, reply, DM)
or are only **observed** (stored as context, no model call). The agent answers in place, posts to
channels, contacts mapped employees, and reads history through a small set of channel tools.
Collectors feed observed chats into the library, where the chunked-audit work of P40 phase D
processes them. Telegram is the first platform with two transports: Bot API (grammY) and MTProto
user account (mtcute).

The gateway lives in **examples/team** for now, written platform-neutral (adapters below a
gateway that never names a platform), so it can move into the library later if it proves generic.

## Use cases (acceptance matrix)

Every design choice is checked against these three; each needs an end-to-end scripted flow and one
manual check with a real test bot and test account before the phase is done.

| | Use case | Must work |
|---|---|---|
| U1 | **Community audit** — thousands of messages a day in groups and channels the team does not control (a bot cannot be added) | MTProto login, admin picks chats, backfill window, live ingest, edits and deletions (ids) plus admin log polling, observe-only (never wakes, never replies), library JSONL → chunked-audit program → report or decision; survives restarts (cursors), `FLOOD_WAIT`, session revocation (`needs-auth` + bell) |
| U2 | **Channel publishing** — scheduled and approved posts | post text, photo, album; edit, pin, delete; schedule through programs/routines (and Telegram native scheduled messages on MTProto); publish gated by the decision center; 4096 / 1024 length limits handled; outbound queue per chat |
| U3 | **Internal group and employees** | employees mention or reply to the agent → it wakes with recent group context and answers in the same topic/reply chain; the agent DMs mapped employees; photos and files reach the agent (multimodal); several agents in one group without bot loops |

## Design

### Layers

| Layer | Role |
|---|---|
| Connector | credentials, setup flow, status — `eharness/connectors` |
| Adapter (transport) | one per platform transport; normalizes inbound events (raw kept, never projected), outbound operations, `capabilities`, optional operations (history, admin log, members), native action catalog |
| Gateway | allowlist → drop self/bots → identity → wake test → `session.enqueue(…, { mode: 'collect', id: <platform message id> })`, or observe (channel log only); outbound queue and rate limits; session keys |
| Tools | `channel_read` (risk `read`), `channel_send` (`external`), `channel_manage` (`destructive`) share one implementation; `channel_describe` (`read`) lists native actions. Native platform actions are deferred tools found through `tool_search`, each with a static risk |
| Collectors | backfill and audit ingest into library JSONL (P40 phase D collector interface) |

One static risk per tool (spec 11) is why the gateway tool is split by risk instead of one
`channel(action)` tool: permissions, program authority and pinned asks keep working unchanged.

### Binding, wake and replies

- A connection is one identity bound to one agent; a group or topic may override `agentId`.
  Several agents in one group = one bot per agent (each has its own native @mention).
- Group policy: allowlist (default) · per group/topic `wake: 'mention' | 'always' | 'never'`
  (`never` = observe-only for audit chats). Implicit wakes: reply to the agent, alias patterns, the
  agent's own topic. Ignore a message that mentions others but not the agent (default on).
- DMs: only team members the owner linked on the People tab (from the "Not linked yet" list, or by
  platform user id); unlinked senders never wake an agent, get silence (unless the connection replies
  to unknown people) and are context only in groups. No deep link, no token.
- Delivery: `final_text` (default; the final answer quotes the trigger and stays in its topic) or
  `message_tool` (only `channel_send` posts; for `wake: 'always'` rooms and program-originated
  posts). `NO_REPLY` is honoured only when `wake: 'always'`.
- Ack reaction 👀 on group mentions, typing indicator on, no streaming in v1 (final message split
  at platform limits).
- Bots: other bots ignored by default; loop guard 20 events / 300 s → 600 s cooldown.

### Sessions

- Shared session per group (turns prefixed with the sender), own session per forum topic, DM
  session per (connection, peer); a DM is never merged with a group. A DM that needs group facts
  uses `channel_read` under normal permissions.
- No automatic reset (compaction handles growth); `/new` is owner-only in groups.
- Unmentioned observed messages are buffered; at wake the last 50 are injected as a turn reminder
  ("messages since your last reply"), never into `instructions`.
- Channel sessions appear in the agent's thread list (P40 phase M) with a source badge.

### Telegram transports

| | Bot API (grammY) | User account (MTProto, mtcute) |
|---|---|---|
| Inbound | long polling + runner, ordered per chat | updates loop with catch-up, per-chat dedupe |
| Sees in groups | mentions/replies (privacy mode) or everything as admin | everything the account can see |
| History / backfill | none (Telegram Desktop export import as fallback) | yes, per-chat cursor |
| Deletions / admin log | no | ids; admin log as admin (short retention, poll often) |
| DMs | only users who started the bot | known contacts only, queued and capped |
| Files | download ≤ 20 MB | chunked, no cap |

The MTProto transport exposes the full API. Safety comes from our side: an outbound queue per chat
and per account below Telegram limits, a daily cap on DMs, `FLOOD_WAIT` parking (never tight
retries), a circuit breaker with a bell alert on ban-like errors, destructive actions through
approvals, no joining by invite link without a human, no member sweeps, no presence tricks
(`readHistory`, typing on the user account), and one live client per session (a lease; a second
client kills the session with `AUTH_KEY_DUPLICATED`).

### Credentials

- Bot token: `apiKey` connector; `test()` calls `getMe` and reports whether the bot can read all
  group messages (privacy mode), with a UI warning when observe needs admin rights.
- MTProto: custom flow (api id/hash from workspace `clientConfig`, phone → code → 2FA password or
  QR → choose chats), bound to the admin principal who started it.
- Library additions (spec 24 + changeset): an opaque sealed `credentials.session` slot that never
  appears in public views; a `qr` flow view; a `resend` action; a server-side credentials read for
  long-lived runtimes. `needs-auth` is set on `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, a revoked
  bot token, and stops all jobs of the connection until reconnect.

### Data and platform terms

Telegram's API terms (§1.5) and bot developer terms (§4) restrict AI use of platform data and
large-scale collection, and require a privacy policy, consent for user-submitted data, deletion of
unneeded data and encryption at rest with a separate key. The example therefore: ingests only chats
an admin chose; never trains or fine-tunes on them; encrypts stored channel messages at rest with
the secret vault; keeps a retention period per chat with a purge job; ships a privacy-notice
template; stores only what a task needs. Operators must review these terms for their own use
(especially U1) before real use.

## Phases

- **L1 — gateway core (team):** contract types, gateway, channel log (encrypted), tools, mock
  adapter, wake/observe/session tests.
- **L2 — library connectors:** session slot, `qr` view, `resend`, server-side credentials read;
  spec 24, changeset.
- **L3 — Telegram bot transport + Channels UI:** connection setup, bindings, per-chat policy,
  employee mapping, outbound queue; U2 and U3 flows.
- **L4 — Telegram user transport:** login flow, chat picker, live ingest, backfill, deletions,
  admin log, collectors into the library; U1 flow.
- Later: Discord and Slack adapters (no gateway change expected).

## Checklist

- [x] L1 (gateway core in `examples/team/server/src/infra/channels`, mock adapter, scripted U1/U2/U3 flows in `test/channels.test.ts`; migration 0021)
- [x] L2 (session slot, `qr` view, `resend`, `service.credentials` / `markNeedsAuth`, spec 24; `subagent({ onPark: 'notice' })`, spec 20 §3.5)
- [x] L3 (grammY Bot API adapter in `infra/telegram`, "Telegram bot" connector, Channels page; migration 0023; fake Bot API tests; manual check with a real bot still open)
- [x] L4 (MTProto user transport in `infra/telegram-user` over mtcute, "Telegram account (MTProto)" connector, account card on the Channels page; migration 0024; **no automated tests for the MTProto transport by owner decision**: manual checklist below)
- [x] L5 (generic conversation model: nodes, identities, messages, events, sessions on nodes; inherited settings; bridgev2-shaped adapter contract; both Telegram adapters on it; the L1-L4 tables migrated at boot; migration 0026; golden fixtures for the bot adapter; the MTProto adapter is moved **without tests**, owner decision; see "L5 notes (as built)")
- [x] L6 (internal groups: people directory and roles, metadata header, role policy, self-knowledge tools, mentions by id, reminders, recaps, proactive policy, decline-on-new-input and approval expiry; migration 0027; see "L6 notes (as built)"; manual check with the owner's real group still open)
- [ ] U1, U2, U3 scripted flows green; manual checks with a real test bot and test account

## L1 notes (as built)

> Superseded in part by L5: tables, ids and the adapter contract described here were replaced by the
> generic conversation model ("L5 notes (as built)" below). Behaviour (wake, outbox, approvals, silence)
> is unchanged.

- Code: `infra/channels/` (`types.ts` contract, `policy.ts` pure rules and config schema, `store.ts`
  SQLite stores, `outbound.ts` queue, `gateway.ts`, `plugin.ts` tools and hooks, `mock-adapter.ts`,
  `vault.ts`). Nothing there names a platform. Wiring: `main.ts` (`Server.channels`), the plugin in
  `agent-factory.ts` (late-bound like the heartbeat), read-only tools allowed in `appRulesOf`.
- Tables (migration 0021; the pairing token flow was removed later, see "Linking without links"): `channel_connections` (config JSON, no secrets), `channel_conversations`,
  `channel_messages` (body sealed with the channel vault: its own key `TEAM_CHANNEL_KEY`, dev file
  `channel.key`), `channel_identities`, `channel_pairing_tokens` (hash only).
- Sessions `channel:<connectionId>:<conversation id>` are `chat_threads` rows with `source: 'channel'`
  and label `<platform> · <title>`. `isThreadSession` and the HTTP `resolve` accept them, so the web
  can open and continue them (a turn that no channel message started posts nothing back).
  `threadSessionOf` skips channel threads when it picks the default chat.
- Wake: `session.enqueue(…, { mode: 'collect', id: 'ev:<platform message id>' })`; the log row's
  `handled` flag lets a redelivery of an event that crashed before enqueue repeat the enqueue, and
  drops a finished duplicate. Delivery reads the trigger from the stored user message
  (`metadata.eharness.inboxKey` / `collected`), so it needs no extra state.
- Observed messages are rows with `pending = 1`; the turn reminder (an instruction with
  `refresh: 'turn'`) shows the newest 50, `turn.end` clears the ones it showed.
- Tool permissions: `channel_describe` / `channel_read` are allowed by rule, `channel_send`
  (external) and `channel_manage` (destructive) keep their risk: in a chat they ask, a program names
  them in its authority. In a rehearsal they are simulated. Native action tools are deferred and
  keep their own risk; a read-risk native action still asks (no allow rule for names the app does
  not know).
- Limits of L1, on purpose: tools are built when a session opens (a binding made later reaches the
  next session); reactions are not stored; `/new` and owner-only commands are not built; a post
  with files is not kept in the outbox.

## L1 hardening (as built)

Against the real use cases (U1 audit, U2 publishing, U3 internal group). Migration 0022
(`channel_outbox`, `channel_approvals`, `channel_conversations.generation`).

- **Outbox** (`delivery-store.ts`, `gateway.ts`). Every reply, post and approval request is a
  sealed row before it is sent (trigger, target, chunk index); claimed by compare-and-set; the row
  id is the adapter's idempotency key (`OutboundMessage.key`); marked `sent` with the platform id.
  Replies and approval requests are retried (backoff, ten attempts, then a bell); on boot due
  rows go out and a row left `sending` by a crash is looked up in the platform history (found =
  sent; absent = sent; no history capability = not resent, failed, bell). `post` rows (tool calls)
  are not retried and not resent after a crash (the model was told; ADR-0014). Chunk order holds.
  A reply to a connection that is down is still queued (chunked at 4000). One reply per trigger.
- **Approvals in chat.** `turn.end` with `stop: 'tool-pending'` of a channel-originated turn
  (the trigger comes from the user message, or from `channel_approvals` for a continuation) posts
  a request per pending item. Capability `buttons` (new `ChannelCapabilities.buttons`,
  `OutboundMessage.buttons`): Approve / Deny, inbound `action` events `approve` / `deny` with the
  approval row id. No buttons, and every question: a link to the thread
  (`<TEAM_WEB_URL>/a/<agent>?t=<thread>`). **Who may answer:** the member the trigger's sender is
  paired with, or a member in the connection's `admins` (default `['owner']`: the example has one
  principal). Others (including unpaired accounts) are refused in chat, nothing changes. The answer
  uses the same `answerAttention` as the web. First answer wins: the chat claims the row first;
  anything else shows up as `pending-changed` in the feed (a wrapper of the activity store) and
  the request is edited ("Answered in the web app"); a late press is told it was answered.
  Platforms without edit get a short follow-up. A turn the web starts in a channel thread
  announces nothing in the chat. The mock adapter has `buttons` and `press()`.
- **Rebinding.** At each wake the conversation's agent is the current binding's. A change bumps
  `generation`: session `channel:<c>:<conv>#2`, a new thread of the new agent; the old thread and
  its pending approvals stay. Observed (pending) messages carry over (they belong to the
  conversation, not the session).
- **Read native actions.** `readActionTools(agentId)` (from the adapters' catalogs) feeds the
  allow rules of the permission engine in `agent-factory.ts` (`createEngine`); other risks ask.
- **Web.** The switcher shows the source badge (the list already did); channel threads can be
  read and continued. The default thread selection is unchanged (the newest open thread, which can
  be a channel thread; the server's `threadSessionOf` still skips them).
- Not done on purpose: answering an `ask_user_question` from the chat (link only); several
  instances sharing one outbox (a second process would treat the first one's `sending` rows as
  its own boot leftovers only at its own boot); file posts in the outbox.

## L3 notes (as built)

- **Code.** `infra/telegram/`: `adapter.ts` (grammY `Bot` + `@grammyjs/runner` + `@grammyjs/auto-retry`,
  pinned exact: grammy 1.46.0, runner 2.0.3, auto-retry 2.0.2; example dependencies, not library),
  `normalize.ts` (update to `InboundEvent`, pure), `format.ts` (HTML escaper, Markdown subset to
  Telegram HTML, post-escape splitting), `connector.ts` (apiKey connector `telegram-bot`),
  `service.ts` (the runtime that starts one poller per connected and bound connection, and the
  admin service behind `ChannelsPort`), `known-chats.ts`. Routes `http/routes/channels.ts`
  (`/channels/connections/...`), web page `/channels`. Migration 0023 (`channel_known_chats`).
  `compose` returns `server.telegram`; `TEAM_TELEGRAM_API_ROOT` points the bot and the connector
  test at a local Bot API server (or a test fake).
- **Polling under Bun works** (long polling, runner, sequentialize per chat, stop while a long poll
  is pending, getFile download) against a fake Bot API in `test/telegram-adapter.test.ts`; this
  closes the soak question for polling. Webhook mode is not built; polling refuses to start while a
  webhook is set (`webhook` state) unless the admin chooses "Remove webhook and poll"
  (`POST .../webhook/delete`).
- **Updates.** `allowed_updates` is explicit (message, edited_message, channel_post,
  edited_channel_post, callback_query, my_chat_member, chat_member, message_reaction). Signals:
  mention by entity (`@botname` or `text_mention` with the bot's id), reply to the bot (the topic's
  first message does not count as a reply), `bot_command` at offset 0 with `@botname` checked
  (a command for another bot counts as addressing someone else). Forum topics are their own
  conversation (`<chat>/<thread>`). Callback queries become `action` events (`<name>:<data>`,
  under 64 bytes) and are answered at once. `my_chat_member` and any chat update feed the known
  chats list (also for chats the allowlist drops).
- **Outbound.** Everything goes through the gateway's outbox and outbound queue. The adapter maps
  Telegram errors to `ChannelError`: 429 -> `rate_limit` with `retry_after`, 401 -> `fatal`,
  403/400 -> `invalid` (a DM before Start says "press Start first"), 5xx/network -> `transient`.
  auto-retry absorbs flood waits of at most 5 s inside one call; longer ones surface as
  `rate_limit` and the queue parks them. Text is HTML (strict escaper; a Markdown subset is
  converted; if Telegram cannot parse the entities the same text is resent plain), split at 4096
  after escaping, buttons on the last part. Files: photo, album (2 to 10 images), audio, video,
  document; a caption over 1024 after escaping goes out as its own message. The idempotency key
  is remembered per process so an in-process retry never posts twice (Telegram cannot dedupe; with
  no history capability a crash is handled by the outbox as "not resent, bell").
- **Files in.** `getFile`, 20 MB cap checked before and after; over the cap the gateway tells the
  model "not loaded: over the limit".
- **Capabilities.** history none, buttons yes, members = administrators only (`getChatAdministrators`),
  topics, reactions, edit, delete, pin, typing, upload. Native actions (deferred tools,
  `telegram_<name>`): `get_chat`, `get_member_count`, `list_admins`, `get_member` (read);
  `pin_message`, `unpin_message`, `create_forum_topic`, `edit_forum_topic`, `close_forum_topic`,
  `reopen_forum_topic`, `set_chat_title`, `unban_member` (write); `send_poll`,
  `create_invite_link` (external); `delete_forum_topic`, `ban_member`, `restrict_member`,
  `leave_chat` (destructive). A refusal is returned as text, never thrown.
- **Setup.** The connector asks for the bot token only (sealed like any connector secret).
  `test()` calls `getMe` (+ `getWebhookInfo`), shows `@username` and explains privacy mode from
  `can_read_all_group_messages`. The Channels page shows the same guidance and warns when a chat's
  policy needs more than mentions and the bot is not an admin. A rejected token (401, at start or
  while polling) calls `markNeedsAuth`, raises a bell (`channel-auth:<id>`) and stops the
  transport; reconnect with a new token on Connectors. The token is scrubbed from every error text.
- **Runtime.** `connectors.rev()` changes (and explicit admin calls) trigger a sync: start when
  the connection is enabled, connected and bound (a gateway config exists), stop otherwise; a
  changed token restarts. Failed starts retry every 30 s (`error` state); `409` (another poller)
  is reported as such. One process must poll a bot: no lease yet (two instances on one database
  would fight with 409).
- **Channels page.** Connections (state badge, next-step hint, agent binding), Chats (discovered
  from updates; allowlist switch, wake mention/always/observe-only, delivery, retention days,
  per-topic wake), People (replaced by "Linking without links" below; linked accounts;
  revoke), Delivery (outbox waiting/failed, breaker with reset, restart). "Observe" is the
  `never` wake (messages are stored as context, the agent never answers).
- **Part A fixes.** An approval request in a chat now shows `key: value` lines (what and where
  first, values clipped, secret-looking keys and values hidden: `summarizeToolInput` in
  `policy.ts`) instead of raw JSON. The web link in channel messages follows `TEAM_WEB_URL`, else
  the server's own public URL when `TEAM_WEB_DIR` is set (same origin), else the Vite dev URL
  (`resolveWebUrl`).
- **Not done.** Webhook mode, a lease for several instances, answering an `ask_user_question` from
  the chat (link only), ack reaction set `message_reaction` as a wake signal (reactions are
  dropped by the gateway), Telegram Desktop export import.

## Open questions

- grammY long polling under Bun: works against a fake Bot API; a long soak with a real bot is still to do. Webhook through `Bun.serve` stays the fallback.
- Whether a plain `@botname` text mention reaches a bot in privacy mode (docs list commands and
  replies only) — test with a real bot.
- Admin log retention (believed about 48 h) — verify with a real account.

## Requests to other phases

- P40 phase M: threads carry an optional `source` and display label for channel sessions.

## L4 notes (as built)

- **Code:** `examples/team/server/src/infra/telegram-user/` (`client.ts` the narrow client interface,
  `mtcute-client.ts` the real client, `login.ts` login sessions of the connect flow, `connector.ts`
  the "Telegram account (MTProto)" connector with steps credentials, method, phone, code (with
  `resend`), QR, 2FA, test and chat choice, `service.ts` runtime, lease and admin API, `adapter.ts`
  live ingest and send, `backfill.ts`, `adminlog.ts`, `collector.ts`, `store.ts`, `errors.ts`).
  Migration 0024: `tgu_chats`, `tgu_counters`, `tgu_leases`, `tgu_settings`, and `channel_messages.rev`
  (change counter for collectors).
- **Credentials:** api_id and api_hash come from `TEAM_TELEGRAM_API_ID` / `TEAM_TELEGRAM_API_HASH`,
  or are entered once in the web connect flow (stored in the secret vault). The session string is
  stored in the vault; nothing secret is logged or returned by the API (phone is masked).
- **Safety:** one live client per session (a lease in `tgu_leases`; a second instance shows state
  `lease` and does not start), flood waits park the chat's jobs, daily DM and total caps, spaced
  sends, a revoked session becomes `needs-auth` with a bell. Chosen chats are observe-only until a
  policy says otherwise.
- **Web:** Channels page lists every connection of every type (type badge, own tabs). "Connect a
  channel" opens a picker driven by the registered connector definitions with category `channels`
  (`ChannelTypePicker`), then the connector's flow (`FlowRenderer`: a `qr` view drawn client-side
  with `qrcode-generator`, and a "Send the code again" button on the code step). The account card
  (`ChannelAccountCard`) has the warning box, agent binding, and tabs Chats (picker with refresh and
  select; chosen chats reuse the policy row), Backfill (window in days and progress), Admin log
  and Limits.
- **Testing decision:** the owner decided that the MTProto transport (`infra/telegram-user/**`) is
  **not covered by automated tests**: no fake MTProto client or account layer was written. It is
  tested by hand with a dedicated test account. The rest of the suite (store schema migrations,
  HTTP schemas, the web model) runs as usual. Treat L4 as unverified until the checklist passes.

### Manual test checklist (dedicated test account, 2FA on)

Set `TEAM_TELEGRAM_API_ID` / `TEAM_TELEGRAM_API_HASH` (from my.telegram.org/apps) or enter them in the flow.
Run one server process. Use a throwaway group where you are admin and another where you are a member.

1. Login by code: Channels, Connect a channel, Telegram account, method Code, phone; enter the code. Connection is saved.
2. Wrong code keeps the form with an error; an expired code can be resent.
3. Resend: press "Send the code again"; a new code arrives; signing in with it works.
4. 2FA: an account with two-step verification asks for the password; a wrong password keeps the step.
5. QR: method QR; scan in Telegram (Settings, Devices, Link Desktop Device); the code refreshes while waiting; 2FA step after the scan if enabled.
6. Chat picker: pick chats in the flow, then Channels, Refresh chats lists groups and channels (no people).
7. Live inbound: select a chat, write there from another account; the message appears in the channel log / agent tools within seconds. Edit it and delete it: edit and deletion are recorded.
8. Wake in a wake chat: change a chosen chat's policy to wake on mention; mention the account; the agent answers; other messages stay context.
9. Observe-only chat: a freshly chosen chat never gets an answer, even when mentioned.
10. Backfill: set a window (for example 7 days) on a chat; progress and oldest date advance; restart the server mid-way and check it resumes from where it stopped; Stop works.
11. Deletion ids: delete a message in a chosen channel and in a group; both are marked deleted (channel deletions carry no chat id, so they are matched by message id).
12. Admin log: in a chat where the account is admin, enable the admin log and press Read now; entries and last-read time show; non-admin chats cannot enable it.
13. Send with limits: have the agent send in an allowed chat; set the daily DM cap to 1 and check the second DM is refused with a clear message; the counters on the Limits tab move.
14. Flood handling (observe only, do not provoke it): if Telegram answers with a flood wait, the chat shows "Paused by Telegram", the bell notifies, jobs resume at the stated time.
15. Session revoke: in Telegram, Settings, Devices, end the session; the connection becomes "Needs a new login" with a bell; Sign in again works.
16. Lease: start a second server process on a copy of the same database; its connection shows "Another instance holds it" and does not log in; stopping the first one lets the second take over after the lease TTL.
17. Shutdown: stop the server with Ctrl-C; it exits cleanly and the lease is released (the next start is immediate).
18. (L5.4) On a copy of a database from before L5 that has an account with chosen chats and a half-done backfill: start the new code; the chats appear as nodes with their settings, the backfill resumes from the stored cursor, the collector source keeps its cursor (no old message is ingested twice) and the Inbox shows the old conversations with their messages.
19. (L5.4) A forum supergroup the account administers: its topics show as children of the forum row on the Channels page, a message in a topic is stored in that topic's node, General is its own child, and a deletion in a topic marks the right message (channel deletions carry no chat id: the gateway finds them by message id).

## Linking without links, silence, inbox and activity (as built, after the real-bot test)

Owner feedback after testing with a real bot. Migration 0025 (`channel_unlinked`, `channel_inbox`,
`channel_events`, `channel_messages.disposition`).

- **No links.** The `/start <token>` deep link, `pairing.issue/redeem` and the Create link UI are
  gone (the `channel_pairing_tokens` table stays, unused, so old databases migrate). `pairing.link`
  links a platform user id to a member by hand.
- **Unlinked senders.** Any DM from an unlinked person is recorded per connection (id, name,
  `@username`, first/last seen, count; no text) and the gateway returns `drop: unlinked-sender`.
  People tab: "Not linked yet" with **Link to member…** and **Ignore**, **Add by Telegram user ID**
  (numeric, validated by the schema and the form), linked accounts with **Unlink** (the person
  reappears under Not linked yet when they write again). Same for the bot and the account.
  Team members: the example has one principal, so the picker offers `owner`, the connection's
  `admins` and members already linked (`GET .../members`).
- **Silence.** Unlinked DM, an old token, a non-allowlisted chat, bots, and a button press by
  somebody who may not answer: no reply (the Bot API callback is answered with no text). The
  per-connection `replyToUnknown` (default off, "Reply to unknown people") sends one neutral line to
  an unlinked DM, at most once per person per 6 hours (in memory). Replies to authorized
  people about approvals (already answered) stay.
- **Inbox tab.** Conversations with title, kind, agent, preview, woke / observed / dropped counters
  and allowlist state; a conversation shows the sealed log decrypted server side, paged back, with
  disposition marks, edits, deletions, approval requests with their outcome, and "Open in the
  agent's thread". Dropped messages create an inbox row with a dropped counter and no text.
- **Activity tab.** `channel_events`: woke / observed / dropped (+ reason), reply queued / sent /
  retried / failed, approval posted / answered, breaker opened, needs-auth. Filter by type and
  conversation, newest first, paged; the tab polls every 5 s (a push stream was not natural: the
  rest of the page polls too). Retention follows the events feed settings.
- **Tests.** `test/channels.test.ts` (silence rules, unlinked recording without text, link by id,
  inbox listing and paging, conversation log, activity), `test/telegram-channels.test.ts` (HTTP
  flow), web `channels/model.test.ts`. Nothing for `infra/telegram-user/**` (owner decision).
- **Not done / open.** An inbound rate limit (the "rate limited" drop reason does not exist: the
  loop guard is the only limiter); a conversation view does not live-update while open (Refresh);
  the unlinked list is not purged by age.

## L5 — Generic conversation model (design, decided 2026-10-12; **built, see "L5 notes (as built)" below**)

Research: mautrix bridgev2 (portal model, network-connector interface), mautrix-telegram/-slack/-discord,
Matrix spaces/threads/relations, Vercel Chat SDK, and the official structures of Telegram (Bot API 10.3 +
MTProto), Discord, Slack and WhatsApp. Goal: one storage model and adapter contract for every platform;
no per-platform tables or columns (the L4 `tgu_chats` table and the flat `{space, container, thread, kind}`
ref are replaced).

### Model

- **Node** — a place, in a single-parent tree with a materialized `path`: `kind` is one of
  `space | room | thread | direct`; structural `traits` are the only thing core logic branches on
  (`multiUser`, `broadcast`, `container`, `threading: none|relation|node`, `postable`, `ephemeral`,
  `external`, `threadsOnly`); `platformType` is display/debug only; `meta` is JSON validated by the adapter's
  schema (versioned). Unique `(connectionId, nativeId)`; native ids are opaque, composed by the adapter.
- **A thread is a node only when the platform gives it its own id and lifecycle**: Telegram forum topics
  (General = topic 0 child of the forum space), Discord threads and forum posts. Slack `thread_ts`,
  Telegram reply chains and WhatsApp replies are message relations (`threadRoot`, `replyTo`).
- **Node links** for non-hierarchical relations: `discussion_of` (channel ↔ discussion group),
  `monoforum_of`, `follows`, `alias_of` (the same chat seen by the bot and the user account: one node per
  connection, linked; the Inbox can merge them), `migrated_from` (basic group → supergroup id change).
- **Node access** per connection: membership role, `canPost`/`canRead` (a broadcast channel is postable
  only by admins), read marker, backfill cursor.
- **Settings inherit down the tree** (`resolve(node, key)` walks node → ancestors → connection default →
  product default): agent binding, wake rule, delivery, observe, retention, session scope, redaction.
- **Identity** per connection with `personId` (the linked team member, never auto-merged), aliases for ids
  that change (phone/LID/username), and per-space profiles (Discord guild nick, Slack workspace name,
  Telegram admin title); memberships.
- **Message**: key `(node, nativeId)`, sender, platform time + sort key, direction, kind
  (message/service/system), content as UIMessage-compatible parts (text, file refs) plus normalized entities
  (mentions, links, formatting) in meta, sealed at rest; `replyTo`/`threadRoot` as plain references that may
  be unresolved; edits kept as revisions; deletions as tombstones (content kept for audit until retention
  unless the node setting `redactOnDelete` is on); `sendTxnId` for echo dedupe; reactions table.
- **Event log**: append-only normalized events (`message.created/edited/deleted`, `reaction.*`,
  `node.created/updated/state_changed/migrated`, `member.*`, `identity.*`, `action`, `backfill.batch`) with a
  unique `(connection, dedupeKey)`, optional prunable raw payload and a normalizer version, so data can be
  re-normalized. Events with an unknown node (MTProto private/basic-group deletions carry no chat id) are
  stored unresolved and resolved later. Inbox and Activity are views over nodes, messages and events.

### Adapter contract (bridgev2-shaped)

Required: `platform`, meta schemas, documented id formats, `connect/disconnect`, `isSelf`, an event stream
(normalized `RemoteEvent`s with the node chain leaf → root), `getNodeInfo` (patch semantics),
`getIdentityInfo`, per-node `getCapabilities` (support levels + limits: text length, edit max age, files),
`send` (with `sendTxnId`; thread/topic expressed by the target node or relations). Optional, discovered by
presence: `edit`, `delete`, `react`, `typing`, `fetchHistory`, `listMembers`, `listNodes`,
`resolveIdentifier`, `adminLog`, native actions. The gateway never branches on the platform name.

### Decisions on the open questions

- Telegram forum General topic: a child thread node (topic 0); the forum itself is a non-postable space.
- One node per connection, joined by `alias_of` links (permissions differ per connection).
- Default session scope: the node where the message was posted (a thread node has its own session;
  relation threads share their room's session); DMs per peer; configurable through inherited settings.
- Content: UIMessage-compatible parts + normalized entities; raw kept separately and prunable.
- Deleted content: kept for audit until the node's retention, unless `redactOnDelete`.

### Phases

- L5.1 schema + migration of `channel_conversations`, `channel_messages`, `channel_inbox`,
  `channel_events`, `channel_known_chats` and `tgu_*` into nodes/links/access/identities/messages/events.
- L5.2 gateway and Inbox/Activity on the new model; inherited settings replace per-chat/per-topic overrides.
- L5.3 bot adapter on the contract with golden fixtures (anonymized real payload shapes per chat type);
  L5.4 MTProto adapter on the contract (manual tests only, owner decision).
- Acceptance: U1–U3 flows unchanged for the client; a new platform needs an adapter and fixtures only.

## L5 notes (as built)

Everything below is in `examples/team/server`; `src/` (the library) is unchanged. Walkthrough: section 28d.

**Storage** (migration `0026_complex_spot.sql`, generated by `bun run db:generate`; plus the boot-time
data migration). New tables, all prefixed `ch_`: `ch_nodes` (tree with a materialized `path`, `kind`,
JSON `traits`, `platform_type`, versioned `meta`, `state`, `legacy_ref_id`), `ch_node_links`
(`discussion_of`, `monoforum_of`, `follows`, `alias_of`, `migrated_from`), `ch_node_access` (what a
connection is in a node: role, `can_post`, `can_read`, read marker, `history` for backfill bookkeeping,
`extra` for adapter-private job state), `ch_node_settings` (inherited settings), `ch_identities` (+
`ch_identity_aliases`, `ch_identity_profiles` per space, `ch_memberships`; `person_id` is the linked team
member; direct-message counters of unlinked people live here), `ch_messages` (key `(node, native id)`,
sealed UIMessage-compatible content, `reply_to_*`, `thread_root_native_id`, `send_txn_id`, tombstones,
`rev` change counter, `pending` / `handled` / `disposition`), `ch_message_revisions`, `ch_reactions`,
`ch_events` (append-only; unique `(connection, dedupe_key)`; node may be null; `normalizer_version`;
optional sealed `raw`), `ch_node_sessions` (the session of an agent for a node, with the old key kept
for migrated nodes) and `ch_meta` (migration markers). `channel_outbox` and `channel_approvals` stay;
their `conversation_id` column now holds a node id.

**Data migration** (`infra/channels/legacy-migration.ts`, run when the gateway is created). Message
bodies are sealed with the channel key, so it cannot be SQL: step 1 (sync, one transaction) turns the
rows that are not sealed into nodes, links, access, settings, identities, sessions and events; step 2
(async, in the background; everything that reads messages waits for it) opens every old message and
stores it again with the same id, sender identity, revisions and change counter. A conversation of
before L5 becomes a node whose `legacy_ref_id` is its old id (so old sessions, threads, approvals and
outbox rows map without rewriting); a forum chat becomes a container room, its old container-level
conversation becomes the `General` thread (`<chat>/0`) and every topic a thread; per-group and
per-topic overrides of the configuration become node settings (a `*` entry joins the connection
defaults, `groups` leaves the config JSON); the account's `tgu_chats` become access (`history` and
`extra.adminLog`) and an `enabled` + `wake: never` setting for chosen chats. It is idempotent (unique keys, markers
in `ch_meta`; `test/channels-migration.test.ts` seeds a database at migration 0025 and boots the new
code on it, then runs both steps again). **The old tables are kept and read by nothing**: dropping them
in the same migration set was judged unsafe (the drop would run before the sealed messages are copied,
and the copy is only verified on the seeded database, not on real data). A later migration drops
`channel_conversations`, `channel_messages`, `channel_inbox`, `channel_events`, `channel_known_chats`,
`channel_unlinked`, `channel_identities`, `channel_pairing_tokens` and `tgu_chats` once the copy is
confirmed on the owner's database.

**Adapter contract** (`infra/channels/types.ts`, bridgev2 shaped). Required: `platform`, `idFormats`,
`start(sink, host)` / `stop`, `self`, `getNodeInfo`, `getIdentityInfo`, `getCapabilities(node)` (per
node, evaluated at send time) and `send(node, message)` with a `sendTxnId`. Optional, found by presence:
`edit`, `delete`, `pin`, `react`, `typing`, `fetchHistory`, `listMembers`, `listNodes`, `fetchAttachment`,
`resolveIdentifier`, `openDirect`, `childNativeId`, native `actions`. Inbound is a stream of
`RemoteEvent`s: `message.created|edited|deleted`, `reaction.added|removed`, `node.created|updated|
state_changed|migrated`, `member.joined|left|updated`, `action`; each carries a `dedupeKey` and the
node as a **chain from the leaf to the root** (`NodeInfo`, patch semantics: missing = unchanged,
`null` = cleared; `meta` merges and is validated by the adapter's `nodeMeta` schema). The host the
gateway gives an adapter offers `isAllowed`, `locate` (find stored messages by native id, for deletions
that name no chat) and `isOwn`. The gateway never branches on a platform name.

**Gateway** (`infra/channels/gateway.ts`). Per event: place it (upsert the chain root first, apply
`links` and `access`) -> append it to `ch_events` (a replay of a structural event or an `action` is
recognized; a replayed message continues to the message-level dedupe) -> structural events
(node state, migration of an id with the settings and the session following, membership) -> the
allowlist (inherited `enabled`) -> self / bot filter -> identity -> linked-DM rule -> wake or observe ->
message store -> `session.enqueue` with the stored message id as the collect id. What changed in behaviour:
messages the identity itself sent (another device, an echo) are stored as outbound and never acted on;
`observe` (default on) keeps the full log of an allowed node, `observe: false` keeps only what addresses
the agent (drop reason `not-observed`); reactions are stored; a deletion that names no chat is placed by
message id, or kept unresolved (`gateway.events.unresolved`, retried by `resolveUnresolved`, which the
hourly purge calls); `redactOnDelete` drops the content at deletion. Unsealed message text never
reaches the event log (payloads are facts; `keepRaw` stores the platform payload sealed, off by default).
`gateway.ingest` stores a message from history (backfill, admin log) without ever acting on it.

**Settings inherit down the tree** (`policy.ts`: `ScopePolicySchema`, `resolveScope`). `enabled`,
`agentId`, `wake`, `implicit`, `aliases`, `ignoreWhenOthersMentioned`, `delivery`, `quote`, `ack`,
`retentionDays`, `observe`, `sessionScope`, `redactOnDelete` resolve node -> ancestors -> the connection's
`defaults` -> the product's; `label` names one node and is not inherited. `ResolvedScope.origin` says
where each value came from (the Channels page shows it). There are no per-chat or per-topic override
tables any more. `enabled` also decides the allowlist: an allowlist connection needs `enabled` somewhere
on the path, an open one allows everything unless a node says `false`; a DM node follows `dm`.

**Sessions** (`ch_node_sessions`, `sessions.ts`). One session per node, `channel:<connection>:<node id>`
(`#n` for the n-th agent). `sessionScope: 'room'` makes a thread share the session of its nearest
non-thread ancestor (one thread of the agent, observed messages of every topic in the reminder, the reply
still goes to the topic the message was in); the default is `node`. The default target of a session's
tools is the node it last answered in. Triggers (outbox `trigger_id`, approvals) are our message ids.

**Inbox and Activity are views.** The inbox lists the postable nodes that have messages or gateway
activity (`woke` / `observed` from the messages' dispositions, `dropped` from `gateway.dropped` events,
so the counters cover the retained window); a conversation is a node id; the log is the node's messages.
Activity is the `gateway.*` part of `ch_events` (`gateway.woke`, `gateway.dropped`, `gateway.reply_sent`,
...), same vocabulary as before, metadata only.

**Telegram bot on the contract** (`infra/telegram`). Native ids: private chat `<user id>`; group,
supergroup, channel `<chat id>`; forum topic `<chat id>/<topic id>`, **General is `<chat id>/0`**; message
`<message id>`; person `<user id>` (`chat:<id>` for a chat speaking as itself, kind `channel` or
`anonymous`). A forum is a `room` with `container: true, postable: false, threading: 'node'` (the design
text said "space"; `space` is kept for guilds and workspaces). A reply chain or a comment is a relation
(`thread_root_native_id`), not a node. `forum_topic_created|edited|closed|reopened`, `migrate_to_chat_id`,
`my_chat_member`, `chat_member`, `new_chat_title`, joins and leaves are node and member events; a
forwarded post in a discussion group adds a `discussion_of` link. `test/telegram-golden.test.ts` +
`test/fixtures/telegram-updates.ts` hold anonymized payload shapes of every kind of chat and update and
assert the normalized nodes and events (and, through the gateway, the tree built from them). The
known-chats table is gone: chats are nodes. Bumping `NORMALIZER_VERSION` is how a change of mapping is
recorded on stored events.

**Telegram account on the contract** (`infra/telegram-user`, **no tests**, owner decision). Same native
ids as the bot (`<chat>`, `<chat>/<topic>`). The adapter implements the contract (`listNodes` for the
dialogs, `openDirect`, `childNativeId`, per-node capabilities), skips chats nobody chose through
`host.isAllowed`, and reports deletions through `host.locate`; ambiguous ids become an unplaced
`message.deleted` the gateway keeps. `store.ts` is now a view over nodes (`nodeChatStore`): "chosen for
ingest" is the inherited `enabled` of the node, the backfill cursor is `ch_node_access.history`, the
admin-log state `extra.adminLog`; `backfill.ts` and `adminlog.ts` are unchanged. Admin-log entries are
`system` messages (`admin:<id>` native id); the collector keeps the item id shape of before L5
(`<chat>[/<topic>]:<message id>`), so ingest does not repeat what it has, and the change counter `rev`
is carried over by the migration so its cursor stays valid.

**HTTP and web.** `GET .../chats` returns the nodes of the connection (chats and topics; people are in the
inbox) with `policy` (what the node sets itself), `effective` and `inherited` (where each value comes
from) as `ChannelNode`; `PATCH|DELETE .../chats/{chatId}/policy` takes a node id (a topic has its own id,
`?topic=` is gone; a `null` field clears a setting so it inherits again). The inbox and activity use node
ids as `conversationId`. The Channels page shows chats and topics as a tree; each node edits only what it
sets itself, every field can "Inherit" and says where the value in force comes from; the account card
lists rooms and keeps its tabs.

**Interpretations and limits.** The interface says `alias_of` links join the bot's and the account's node
for the same chat, and the Inbox can merge them: the store and the link relation exist, nothing creates
the link yet. Session scopes are `node` and `room` (a per-reply-chain scope was not built). Messages from
bots the connection does not allow are still dropped unstored. Reactions in a forum arrive without a topic
and are matched in the chat's subtree. `bun run db:generate` gave migration number **0026**.

**Left for L6.** The people directory, roles and divisions, the metadata header of a turn, role based tool
policy, `channel_status` / `list_topics` / `member_lookup` / `chat_history` / `chat_recap` / `reminder`,
mentions by id, the proactive policy and the approval-expiry rules (all below), plus: creating `alias_of`
links, dropping the old tables, a per-reply-chain session scope, and manual verification of L5.4 with a
real account (checklist item 18 and 19 below).

## L6 — Internal groups: identity, roles, context, reminders, recaps (decided 2026-10-12; after L5)

Use case: a company supergroup with forum topics per division; the founder/CEO, admins and employees
talk; the bot is tagged to take notes, set reminders for the group or one person, and reminds
proactively. Findings from a real test: the admin bot claimed it was not admin and could not read other
topics (it guessed instead of checking; admins always receive every topic, but unaddressed messages were
not logged), it pinged people with free-text @usernames, and a chat claim ("I am the founder") was believed.

Decisions:
- **People directory** on the L5 identities: keyed by platform user id (never username); person ↔ team
  member link created only by an authorized action (People tab, admin import), never by chat text; roles
  `owner | admin | member | guest` plus divisions (topic nodes); Telegram creator/admin status is imported as
  a suggestion, not a role. Anonymous admins (`sender_chat` = the chat) are "admin, identity unknown" with
  guest rights.
- **Complete metadata in every inbound turn** (rendered as data, never instructions): sender name, @username,
  platform user id, directory role and divisions, team member link, chat admin status/title, bot,
  anonymous; chat title/type/id, topic name/id, message id, reply-to (id, sender), time in the team
  timezone, edited, forwarded-from. The agent is told roles come only from this header.
- **Authorization by code on the current requester**: deny-wins tool policy per role (e.g. approvals,
  reminders for others, schedules, writes: owner/admin; members: own reminders, read/recap of their
  divisions; guests: answers only), plus division scope for recaps and reads.
- **Observe = full log** for allowed chats/topics (every message stored, sealed), so recaps and "who said
  what" work; topic nodes learned from `forum_topic_created/edited` and incoming messages; optional one-time
  MTProto topic list/backfill when an account connection exists.
- **Self-knowledge tools** (read): `channel_status` (am I admin, rights, privacy, log coverage since when),
  `list_topics`, `member_lookup` (by id/name/username → directory entry), `chat_history` (time window,
  topic filter).
- **Mentions**: only the gateway builds mention entities, from structured `mention: [personId|userId]`
  (Telegram `text_mention` by id, works without username); free-text `@handles` in model output are
  neutralized (Discord `allowed_mentions` model).
- **Reminders from chat**: one `reminder` tool (`create | list | cancel | update`) stored as routines with the
  team timezone; targets the current topic by default; mentions by id; confirmation echoes the absolute time
  and topic; fixed-text reminders are sent without a model call; role rules decide who may remind whom;
  delivery through the outbox with retries and a fallback when a topic is closed.
- **Recaps**: `chat_recap` (window in the team timezone, one topic or all allowed topics, chunked), saves a
  note to the library with its source range, respects division scope, says plainly when the log starts after
  the window.
- **Proactive policy** per node (inherited settings): allowed targets, quiet hours, one digest per topic
  instead of many pings, mention limits, silent when nothing to say, no reminder-from-reminder recursion.
- **New input while an approval is pending** (web parity): a wake message from the requester declines
  pending approvals with the user-note wording and is processed; others stay context; the approval message
  is edited to "Cancelled: a new message arrived"; unanswered approvals expire (default 24 h).

Acceptance (real bot, owner's group): CEO tag → correct role in the header; employee claims to be the
founder → still employee; "note today's chat" → recap of all allowed topics saved; "remind the group at
15:00" and "remind <person> tomorrow 9:00" → delivered with an id mention; proactive overdue digest in the
right topic; no accidental @pings.

## L6 notes (as built)

Everything is in `examples/team` (server, web, docs); `src/` (the library) is unchanged. Migration
`0027_living_mac_gargan.sql` adds three tables (`ch_people`, `ch_reminders`, `ch_proactive`), purely additive. A
connection configuration stored before L6 parses with the new defaults (`people.defaultRole: guest`,
`approvalTtlMs: 24 h`).

**Directory and roles** (`infra/channels/people.ts`, `roles.ts`). `ch_people` keeps, per identity (platform user
id, never a username), a role `owner | admin | member | guest` and divisions (node ids: a topic, or a room which
covers its topics). Effective role, in this order: a chat speaking as itself (anonymous admin, channel) or a bot is
`guest` whatever the directory says; the directory entry; the team member the identity is linked to (a member in
the connection's `admins` is `owner`, any other linked member is `member`); the connection's `people.defaultRole`
(`guest`). Roles are written only by `gateway.people.setRole` (People tab, `PUT .../people/{peerId}/role`), never by
chat text. The platform's admin status (`ch_memberships`: `member.*` events, `getChatAdministrators` through
`adapter.listMembers`, now returning `role` and a custom `title`) is a **suggestion**: the People tab shows
"suggested: admin in TEAMKU" with one button to confirm. The admins of an allowed group are refreshed on its first
message every 6 hours, and on demand (`POST .../people/import`). Telegram: `listMembers` maps `creator` to owner
and `administrator` to admin with `custom_title`; `chat_member` events carry the title; `my_chat_member` stores the
bot's own rights (`access.extra.rights`); `NORMALIZER_VERSION` is 2.

**Header** (`header.ts`). Every wake message starts with a `<message-meta>` block (data, escaped so it cannot be
closed from a name): sender name, `@username`, platform user id, role and where it came from, divisions, linked team
member, chat admin status and title, bot / anonymous; chat title, kind and id, topic name and id, message id,
reply-to (id and sender), time in the team timezone, edited, forwarded-from. Observed messages in the turn reminder
carry the same data in one line each. The session note tells the agent that roles are only what the header says and
that claims in the text change nothing.

**Authorization by code** (`roles.ts`, `plugin.ts`). The channels plugin's `turn.start` hook records the requester
of the turn (the sender of the wake messages; the lowest role if several people triggered it; a continuation after
an approval keeps the original requester) and its `tool.approve` hook calls `decideTool(role, tool, risk)`:
deny list first (deny wins), then `tool_search`, the role's allow list, its allowed risks; an unknown risk counts as
a write. Defaults: owner and admin all risks; member the channel read tools, `channel_status`, `list_topics`,
`member_lookup`, `chat_history`, `chat_recap` and `reminder` (reads scoped to their divisions in the tools); guest
`channel_status` only. Overridable per connection (`people.policy`). Refusals are readable strings telling the model
to relay them. A turn no chat message started (the web, a program) has no requester and is not restricted by roles.
Approvals in a chat: only an owner or admin may answer; in a direct chat the person who asked may answer their own
(not a guest).

**Self-knowledge tools** (`self-tools.ts`, layer 1). `channel_status` (admin status, rights, privacy, log coverage,
allowed places, who is asking, team time), `list_topics`, `member_lookup`, `chat_history` (time window or from/to in
the team timezone, topic filter, paged), `chat_recap` (the same window as a transcript in chunks of about 12 000
characters, with a cursor), `chat_recap_save` (writes `/library/recaps/<date>-<title>-<id>.md`; the source range,
message count and log coverage are written by code, not by the model) and `reminder`. The recap is summarized by
the agent chunk by chunk (no hidden model call); the tool says plainly when the log starts after the window and
which topics were left out for the requester's divisions. Read tools are allowed by rule; `chat_recap_save` and
`reminder` (writes inside the team's own space) are allowed by rule too, roles decide who.

**Mentions** (`mentions.ts`). The only way to ping somebody is the structured `mention: [platform user id or team
member id]` of `channel_send` and `reminder`; the gateway writes a private-use token into the text and an adapter
with capability `mentions: 'id'` renders it (Telegram: `<a href="tg://user?id=...">name</a>`, which pings people
without a username); for other adapters it is the plain name. All free text (final replies, sends, reminder text) is
neutralized: `@handle` becomes `@` + zero-width space, forged tokens are stripped. A message may mention at most
`proactive.maxMentions` people (default 3).

**Reminders** (`reminders.ts`, gateway `reminders`). One tool, `create | list | cancel | update`. A reminder is a
row in `ch_reminders` plus a `sys:reminder:<id>` routine (claim, catch-up of 12 h after downtime, recovery); the fire
posts `Reminder: <text>` (with the mention tokens) through the outbox as kind `reminder` (retries, deduplicated per
`reminder:<id>:<slot>`) with **no model call**; the routine service hands `sys:reminder` fires to
`gateway.reminders.fire`. "When" is `at` ("YYYY-MM-DD HH:MM" in the team timezone), `inMinutes`, or `repeat`
(daily, weekdays, weekly, monthly) with `time`; the confirmation echoes the absolute time, zone and place. Target:
the current chat and topic unless named. Role rules: a member only reminds themselves (mention is forced to
themselves) and cancels or changes only their own, in places they may read; staff remind anybody or the whole chat; no
reminder is created from a scheduled or automated run (no reminder from a reminder). A closed or removed topic
falls back to the room (or General). The web lists and cancels them (Channels, Reminders tab).

**Proactive policy** (`policy.ts` `proactive`, gateway `proactive`). Inherited node setting: `allowed` (default
off), `quietHours`, `digest` (default on) with `digestMinutes` (60), `maxMentions`. It applies to `channel_send` from
a **routine or heartbeat** session (a program's authority names the tool on purpose and is exempt, so U2 still works):
refused unless allowed; empty or `NO_REPLY` text is silent; held in quiet hours and while a digest collects posts
(`ch_proactive`), then sent as one message per node by the maintenance pass (`gateway.proactive.flush`, every
60 s). Reminders people asked for ignore quiet hours but obey the mention limit.

**Approvals** (gateway). A wake message in a session with open approvals: from the person who asked (or an owner or
admin) it declines them with the user's note (`userDeclinedText` wording, the message is the note), continues the
parked turn with it (the answer quotes the new message) and edits the request to "Cancelled: a new message arrived";
from anybody else it is stored as context and the approval stays. Unanswered approvals and questions expire after
`approvalTtlMs` (default 24 h, People tab) and are declined with "not answered"; the request is edited to "Expired:
not answered". Library: no approval timeout exists, so this is app logic (`expireApprovals`).

**Tests.** `test/channels-l6.test.ts` (roles and spoofed claims, deny-wins per role, header, self-knowledge tools,
mentions and neutralization, reminder lifecycle including no model call and permissions, recap windows and division
scope, proactive quiet hours and digest, decline on new input and expiry); `test/channels.test.ts` was adapted: its
people act as admins because L6 made approvals in a chat a staff action. Web: `channels/model.test.ts`.

**Follow-up pass (e2e findings, real DeepSeek run).**

- *D1 questions in chat.* A pending `ask_user_question` used to swallow every later message of its
  conversation (the parked session queued them) and posted a `http://localhost:5173` link. Now a question is
  posted in the chat (`questions.ts` renders it: numbered options, "reply with a number, an option or your own
  answer"); a single-choice single question also gets one button per option (`o` action, data
  `<row id>:<option index>`). The requester's next message in that conversation (even one that does not address
  the bot) answers it: a number or an option label selects it, anything else is the "Other" text; a multi-select
  accepts several separated by commas. Several questions are answered in order ("Noted (1 of 2)", progress kept
  in memory) or all at once with one line per question. Staff may answer too; anybody else's message stays
  context. The post is edited to `Answered: ...` (also `Expired:`). The answer reaches the model as the same
  tool output as in the web app (`answerOutput`, in `attention.ts`); the questions are read from the session's
  pending state, so no schema change. DMs behave the same.
- *No dead conversations.* A wake message while the session waits on something no chat can resolve (a turn of
  the web app parked on an approval, a question asked in another topic of a shared session, an answer path that
  is missing) gets one explanation per pending item, and is stored as context; somebody who may not answer an
  approval that waits is told once whom it waits for. Process state: `parkedUnannounced` is not persisted (after
  a restart the old queue behaviour returns for that session until its next turn).
- *Links.* `webLink` returns nothing when the web URL is loopback, so no chat message carries `localhost`.
- *D2/D3 reminders.* A member creates a reminder only for themselves: `mention` must name them (no mention =
  the whole chat = refused with the id to use); it is delivered with their own mention as
  `Reminder for <name>: <text>`. Reminders for others or the group need an owner or admin. The text is stored
  and delivered verbatim (tool description: pass the person's words); the gateway adds one `Reminder:` label
  only when the text has none (`reminderText`).
- *Web.* U1: number inputs bind numbers; `fieldText` and the helpers (`proactiveError`, `retentionError`,
  `policyBody`, `formChanged`, `limitsBody`, `lastWindowDays`) accept `string | number | null`; the same pattern
  in `providers/form.ts` (a bound number input was read as empty and dropped) is fixed. U2: quiet-hours
  placeholders and a line show the values in force. U3: the row names the connection ("Acme bot · Admin in this
  chat"). U4: the People list is ordered by name only (stable under role changes). U5: the wake hint follows the
  selected value.

**Not done / limits.** Multi-part question progress is in memory (a restart asks again from the first part).
`alias_of` links, dropping the L1-L4 tables and an MTProto topic list are still open. A turn started by several
people runs with the lowest role. The tool policy does not look at what a read tool reads outside the channels
(a member can use any tool in their allow list; the default list is channel reads and reminders only).

### Medium context, memory discipline, default role and reminders on Routines (owner real-group pass)

Everything in `examples/team`; `src/` unchanged. No migration. Reported by the owner after trying the bot in a real
group (verbose, over-explaining replies, memory polluted with roles, a "guest" co-founder refused, a reminder that
posted the request).

- *Medium vs persona* (`channels/medium.ts`, gateway `sessionNote` / `mediumNote`). The persona owns voice and
  tone. The session note (instructions) now starts with **system rules** that no persona overrides: the agent's
  name comes from configuration (the agent name, plus `TEAM_NAME` when set; no invented product or platform names),
  never explain internals (directory, tool names, "the tool refused"), roles only from the header, and the memory
  discipline below. A second, per-turn **medium reminder** (`refresh: 'turn'`, not instructions) says where the
  agent is (DM, or group/topic) and the default reply length: short in a group, normal in a DM; the inherited node
  setting `replyStyle: brief | normal | detailed` overrides it, and the text says the persona wins too. A refusal to
  the requester is one polite sentence.
- *Memory discipline* (channels plugin `tool.approve`). In a channel session: (a) `memory_view` is denied for a
  turn whose triggering messages are all small talk (`isSmallTalk`: greetings, thanks, pings) with a readable reason,
  and the protocol text says reads are on demand (the memory plugin's own protocol, "view relevant files before a
  task", is static; the session note overrides it for chats); (b) `memory_create | str_replace | insert` whose new
  text states a role, admin status, permission or capability (`systemFactIn`, a small documented regex list for ID
  and EN) is denied with "Not saved: ... that is system state ... use channel_status / member_lookup / the header".
  Heuristic by design: obvious statements only. (c) `examples/team/scripts/clean-memory.ts` (never run
  automatically) lists the files the same detector flags, and removes chosen ones after writing a backup.
- *Default role per chat*. Inherited node settings `defaultRole: guest | member` (Channels -> Chats -> "Trusted
  internal group") and `replyStyle`. `resolveIdentityRole(connection, identity, node?)` uses the node's value before
  the connection's `people.defaultRole`; the header, tool policy and `member_lookup` (with the asking chat) all use
  it. Owner and admin remain explicit. `GatewayDeps.notify` got an optional `link`; the gateway raises one bell per
  new unknown person and one per unconfirmed platform-admin suggestion (keys `channel-person:<id>`,
  `channel-suggest:<id>:<role>`, deduped), linking to `/channels?connection=<id>&tab=people` (the connection card
  opens the tab the link names).
- *Reminder contract*. `reminder` takes `message` (posted when it fires; must read as the reminder, "Waktunya
  pulang"), `request` (context only) and `verbatim`. `misusedMessage` refuses a message that starts like a request
  ("ingatkan", "remind me", "set a reminder"...) or equals / contains the request, with a correction; a leading
  `Reminder:` label is judged by what follows; `verbatim: true` skips the check. The old `text` field is gone.
  Delivery is unchanged (fixed text, no model call). The request is not stored.
- *Reminders on the Routines page*. `GET /routines` now returns `reminders` next to `routines`: the reminders of
  every connection (active first, then the 50 most recent finished or cancelled), each with `place`
  (`<chat>/<topic>`), status, `nextAt` for a one-time one. The page shows them with a "Reminder · <place>" badge, a
  status badge and a cancel button (the channels reminder API), and a filter (routines and reminders, routines only,
  active reminders, finished reminders). Reminder create, fire and cancel emit `routine-changed` so the page
  refreshes. **Decision**: the other `sys:` routines (heartbeat, digest) stay hidden: they have their own surfaces
  (Heartbeat settings, Briefings) and no action that makes sense on the Routines page.
- *Who is here*. `member_lookup` without `query` lists the people of the chat from the directory plus everybody seen
  writing there (memberships), with role, divisions, platform admin status and last seen, and one line that says how
  many have no role set by the team (complete them on the People tab). The tool description tells the model not to
  explain platform limits beyond a clause.
- *Thread titles*. At boot (after the message migration) `retitleThreads` renames channel threads whose title is the
  bare chat, topic, native id or old label to "<chat> / <topic>", once; a title a person chose is left alone; a
  second pass changes nothing.
- *Question labels*. A reply is matched to an option by number ("2", "nomor 2", "pilih 2", "option 2"), exact label or
  a number/pick word before the label, so "Answered:" shows the option label. A tap already did.
- *Tests*. `test/channels-medium.test.ts` (pure rules, medium and system rules on the wire, memory guard, small-talk
  memory denial, trusted group and bells, reminder contract, Routines list with finished reminders, who is here,
  retitle); web `routines/reminders.test.ts`, `channels/model.test.ts`. The L6 reminder tests use `message`.
- *Limits*. Memory reads for small talk are denied by code only for the narrow greeting vocabulary; the rest relies
  on the instruction. The write guard is regex-based and can miss a paraphrase or flag a harmless note (the reason
  is readable and the agent can rewrite). `request` is not persisted.

### Tool layering rule (owner emphasis)

Two layers, kept strict:
1. **Generic channel tools** (every platform, filled by adapters, capabilities per node): read messages/history,
   chat info, person info, topic list, own status (`channel_status`, `list_topics`, `member_lookup`,
   `chat_history`, `chat_recap`, `reminder`), send/reply/edit/delete/pin/react, mentions by id.
2. **Native platform actions** (deferred tools found via `tool_search`, static risk each): e.g.
   `telegram.forwardMessage`, `copyMessage`, `createForumTopic`, `banChatMember`, `setChatMemberTag`;
   later `discord.createThread`, `slack.setTopic`.
Rule: an action is generic when it means the same on at least two platforms and degrades safely where
unsupported; otherwise it is native (forward is native: Telegram forward/copy, Discord forward and Slack share
links differ). Basic needs (am I admin, who is this, which topics exist) must never require a native tool.

## Review pass (hardening, written not run)

- A chat turn whose sender cannot be resolved is a guest (never unrestricted); web and program turns
  stay unrestricted by design.
- `channel_send` `upload` follows the proactive policy like text (a file cannot be held for a
  digest); `react` is exempt. Assigned `task:` sessions created by the client (or granted
  `channel_send`) post like chat; routines, the heartbeat and agent-made tasks stay proactive.
- Reminders: cancel keeps a done reminder done; at most 10 repeating reminders per person
  (`TEAM_MAX_REPEATING_REMINDERS`).
- Legacy message migration: a body the key cannot open is counted and logged once; after 3 boots it
  gives up and marks `gaveUp` in `ch_meta`. Dead `void` statements removed.
- Tests are written (`channels-l6.test.ts`) but were not run in this pass.
