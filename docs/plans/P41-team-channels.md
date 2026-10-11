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
- DMs: only employees mapped through a one-time `/start <token>` deep link; unmapped senders never
  wake an agent and are context only in groups.
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
- [ ] L3
- [ ] L4
- [ ] U1, U2, U3 scripted flows green; manual checks with a real test bot and test account

## L1 notes (as built)

- Code: `infra/channels/` (`types.ts` contract, `policy.ts` pure rules and config schema, `store.ts`
  SQLite stores, `outbound.ts` queue, `gateway.ts`, `plugin.ts` tools and hooks, `mock-adapter.ts`,
  `vault.ts`). Nothing there names a platform. Wiring: `main.ts` (`Server.channels`), the plugin in
  `agent-factory.ts` (late-bound like the heartbeat), read-only tools allowed in `appRulesOf`.
- Tables (migration 0021): `channel_connections` (config JSON, no secrets), `channel_conversations`,
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

## Open questions

- grammY long polling under Bun needs a soak check; webhook through `Bun.serve` is the fallback.
- Whether a plain `@botname` text mention reaches a bot in privacy mode (docs list commands and
  replies only) — test with a real bot.
- Admin log retention (believed about 48 h) — verify with a real account.

## Requests to other phases

- P40 phase M: threads carry an optional `source` and display label for channel sessions.
