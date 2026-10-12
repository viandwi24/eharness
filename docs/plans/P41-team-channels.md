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
- [ ] U1, U2, U3 scripted flows green; manual checks with a real test bot and test account

## L1 notes (as built)

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

## L5 — Generic conversation model (design, decided 2026-10-12; build after the e2e browser run)

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
