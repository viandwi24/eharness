# Scripts and tables: scenario catalog and capability checklist

Research for the `examples/team` scripts + tables feature (see `examples/team/docs/scripts.md`,
`examples/team/docs/tables.md`). Goal: list what people really automate with Telegram bots and
userbots, n8n/Make/Zapier, and Airtable/Baserow/NocoDB, then derive what a "mature" script
runtime must offer. Written 2026-10-26.

**Status column** (`Now`): what the team app offers today, judged from `scripts.md`, `tables.md`
and the `ctx` method list in `examples/team/server/src/infra/scripts/host.ts` (work in progress at
the time of writing). ✓ = exists, ◐ = partial, ✗ = missing.

## Key findings

1. **Copy, do not re-upload.** Every serious forwarder/copier republishes posts as new messages
   ("copy", no "Forwarded from") with the media kept by file reference. Bot API `copyMessage(s)`
   keeps photos, videos, stickers, voice and albums without downloading; download + re-upload is
   capped (bots: 20 MB download, 50 MB upload) and loses stickers/voice semantics.
2. **Albums arrive as N separate updates** sharing a `media_group_id`. n8n/Make users hit this
   constantly ("publishes 1 photo instead of the album"). A mature runtime groups them into one
   event (short debounce) and can copy/send the album as one unit.
3. **Message id mapping is the core of signal distribution.** Edits, follow-up replies ("TP1 hit"),
   deletes and reply threading in target channels all need "source message → copies per target".
4. **Bots do not get deletions; userbots get them unreliably.** Edits arrive (`edited_message`,
   `edited_channel_post`). Delete-sync must be best-effort and documented.
5. **Delays and timeouts are everywhere**: "post after 10 min", "delete the welcome after 2 min",
   "kick if captcha not solved in 5 min", "random 30–90 s delay". The sandbox has no timers, so a
   one-shot delayed run (`ctx.later`) is a must-have.
6. **Flood limits are hard**: ~1 msg/s per chat, 20 msg/min per group, ~30 msg/s per bot. Fan-out to
   many channels needs a queue with `retry_after` handling, not bare sends.
7. **Moderation = typed filters + actions**: Rose locks 48 message types (photo, sticker, forward
   from channel, custom emoji, url, invite link…). Triggers need structured filters for media kind,
   forward origin, links, sender role, and ctx needs ban/mute/restrict/approve.
8. **Table automations want transitions, not every update**: Airtable "when record matches
   conditions" fires only when a record *starts* to match; "when record updated" watches chosen
   fields. Without this, table triggers are noisy and loop-prone.
9. **Dry/training mode is standard in anti-spam** (tg-spam `--dry`, `--training`): detect and log
   without acting. Matches the existing dry run, but should also exist as a live "shadow" mode.

## 1. Scenario catalog

Legend for ctx: `send`, `copy` (copy message/album by reference), `fwd` (forward with origin),
`reply`, `edit`, `del`, `pin`, `react`, `btn` (inline buttons/callbacks), `mod` (ban/mute/restrict/
approve), `poll`, `dl` (download to library), `tbl`, `kv`, `http`, `later` (delayed run),
`wake` (agent), `notify`, `lib`, `api`.

### A. Signals and trading channels

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| A1 | Signal distributor: copy each post of a source channel to N target channels (no "forwarded from") | `message.created` in source channel | `copy` ×N, `tbl`/`kv` (id map) | All kinds; albums as one unit; captions kept |
| A2 | Edit sync: source post edited → edit every copy | `message.edited` in source | id map lookup, `edit` (text or caption) | Caption edit on media; media replace (editMessageMedia) |
| A3 | Follow-up threading: source reply "TP1 hit" → post in each target as a reply to *its* copy | `message.created` with `replyTo` | id map, `send/copy` with `replyTo` | Screenshots of PnL (photo) |
| A4 | Signal logger: parse pair/side/entry/SL/TPs into a `signals` row | `message.created` + regex | `tbl` upsert by source msg id | Chart image: save file ref / `dl` |
| A5 | Outcome tracker: replies "TP2 ✅" / "SL ❌" update the parent signal row (status, hit time, R) | reply in source + regex | `tbl` update by parent msg id, `inc` | Optional result screenshot |
| A6 | Rewrite/brand: strip source links/@mentions, replace words, add footer/CTA before posting | as A1 | text transform, `copy` with new caption | Caption ≤ 1024 chars; formatting entities preserved |
| A7 | Free vs VIP delay: VIP gets the signal now, free channel 30 min later (or only results) | as A1 | `copy` now, `later` + `copy` | Same as A1 |
| A8 | Filtered routing: only BTC/ETH signals to channel X, forex to Y; skip non-signal chatter | as A1 + regex / parsed fields | branch, `copy` | Skip sticker/voice-only posts |
| A9 | Weekly/monthly performance report (win rate, R, per pair) posted + saved | schedule | `tbl` aggregate, `send`, `lib` | Optional chart image (generated file) |
| A10 | Multi-source merge: 3 provider channels → one curated channel, dedupe same signal | `message.created` in several | dedupe key in `kv`/`tbl`, `copy` | Albums |
| A11 | Signal expiry: no TP/SL after 48 h → mark expired, post note | schedule or `later` per signal | `tbl` query/update, `reply` | — |
| A12 | Delete-sync (best effort): source deleted → delete copies | `message.deleted` (userbot only) | id map, `del` | Album = delete every item |
| A13 | Price check: on signal, fetch price from exchange API, annotate or reject stale | as A4 | `http`, `tbl` | — |
| A14 | Reaction mirror/poll: copy reaction counts or add 🔥 to every distributed post | `reaction.*` / after copy | `react` | Custom emoji reactions |

### B. Community moderation

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| B1 | Locks: delete forwards from channels, invite links, URLs, stickers in a group (Rose-style) | `message.created` + kind/forward/url filters | `del`, warn `reply` | Filter by media kind incl. premium/animated sticker, custom emoji |
| B2 | Blocklist words/regex → delete + warn; 3 warns → mute 24 h | `message.created` + regex | `del`, `kv` counter, `mod` mute | Check captions too |
| B3 | Antiflood: > N messages in M seconds → mute | `message.created` | `kv` sliding window (rate counter), `mod` | Media bursts (albums count as one) |
| B4 | New-member probation: first 24 h no links/media | `message.created` + member join time | `kv`/`tbl` join time, `del` | Media kind filter |
| B5 | Spam score: CAS check, emoji count, link count, duplicate text; first message only | `member.joined` / first message | `http` (CAS API), `kv`, `mod`, `notify` admins | Media-only first message flagged |
| B6 | Report flow: `/report` reply → admin chat gets the message with Ban/Ignore buttons | command in reply | `fwd`/`copy` to admin chat, `btn`, `mod` | Reported media copied |
| B7 | Federated ban: ban in one group → ban in all owned groups | admin command / `member.updated` (banned) | `mod` across chats | — |
| B8 | Night mode: lock media/sending 00:00–07:00 | schedule ×2 | `mod` set chat permissions | — |
| B9 | Clean service messages ("X joined", "pinned") | service events | `del` | — |
| B10 | Escalate ambiguous content to an agent (LLM) only when rules can't decide | `message.created` | `wake` | Photo/voice: pass file ref |

### C. Onboarding

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| C1 | Welcome message with rules + buttons; auto-delete after 2 min | `member.joined` | `send` with `btn`, `later` → `del` | Welcome image/GIF |
| C2 | Captcha: mute on join, "I'm human" button, unmute on press, kick after 5 min | `member.joined`, `action` (button) | `mod`, `btn`, `later`, `kv` | — |
| C3 | Join-request screening: DM the applicant a question, approve/decline by answer or timeout | `member.join_requested`, DM reply | DM `send` (bot may DM applicant ~5 min), `mod` approve/decline, `later` | — |
| C4 | Paid/VIP access: approve join request only if member is in `subscribers` table and not expired | `member.join_requested` | `tbl` lookup, `mod` approve/decline | — |
| C5 | Expire VIP: daily, remove members whose subscription ended, DM renewal link | schedule | `tbl`, `mod` kick, `send` | — |
| C6 | Goodbye/left log to a table (churn tracking) | `member.left` | `tbl` | — |

### D. Content cross-posting

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| D1 | Cross-post channel → other channels/groups/topics with per-target caption template | `message.created` | `copy`, caption override | Albums, video, document |
| D2 | Scheduled posting queue: rows in `posts` table with `publishAt` → publish | schedule (every min) or `later` per row | `tbl`, `send` with files/`btn`, `pin` | Library files; albums from file lists |
| D3 | RSS/website → channel | schedule | `http`, dedupe `kv`, `send` | Link preview control, cover photo |
| D4 | Watermark/append logo before reposting | as D1 | `dl` → transform (http service) → `send` | Photos/videos (size limits) |
| D5 | Auto-pin latest announcement, unpin previous | `message.created` with tag | `pin` | — |
| D6 | Auto-delete posts after N hours (temporary promos) | after send | `later` → `del` | Albums |
| D7 | Repost best posts: weekly, repost top-reacted posts | schedule | `history`/reaction counts, `copy` | Any |
| D8 | Media archive: every photo/document in a group saved to the library + indexed in a table | `message.created` + has media | `dl`, `tbl` | Files ≤ download limit |
| D9 | Voice note → transcript posted as reply (agent or STT API) | `message.created` kind=voice | `dl`, `http`/`wake`, `reply` | Voice/video note |

### E. Customer support / FAQ

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| E1 | Keyword auto-reply / Rose-style filters ("price" → price list) | `message.created` + regex | `reply` | Reply with photo/document/sticker |
| E2 | Notes: `#rules` / `/faq x` returns a stored note from a table | command | `tbl`, `reply` | Notes may hold media |
| E3 | Ticket: DM to bot creates a `tickets` row, forwarded to staff group; staff reply routes back | DM `message.created`; reply in staff group | `copy`, id map, `tbl`, `send` | Customer screenshots both ways |
| E4 | Out-of-hours auto-answer once per user per day | DM `message.created` | `kv` dedupe with TTL, `reply` | — |
| E5 | Escalate to an agent after 2 unanswered messages or angry words | DM | `kv`, `wake` | — |
| E6 | CSAT poll after ticket closed | `row.updated` (status → closed) | `poll` or `btn`, `tbl` | — |

### F. Sales / leads

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| F1 | Lead capture: bot asks name/phone/budget step by step | DM messages, `action` | `kv` conversation state, `btn`, `tbl` | Contact share |
| F2 | Webhook from payment/checkout → grant VIP (invite link), log order | `webhook` | `tbl` upsert, `channels.action` (create invite link), `send` DM | — |
| F3 | Abandoned lead follow-up after 24 h | `later` / schedule | `tbl`, `send` | — |
| F4 | Giveaway: collect entries via button, check channel membership, draw random winners | `action`, schedule | `btn`, `channels.members`/get member, `tbl`, random, `send` | Announcement image |
| F5 | Referral tracking: invite link per member, count joins per link | `member.joined` (invite link) | `channels.action` (create link), `tbl` inc | — |

### G. Analytics / reporting

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| G1 | Daily group activity: messages per user/hour, top posters | `message.created` (count) + schedule | `tbl` inc / aggregate, `send` | Count media by kind |
| G2 | Channel growth: member count daily snapshot | schedule | member count, `tbl` | — |
| G3 | Post performance: views/reactions/forwards per post after 24 h | `later` per post / schedule | post stats (`message` views), `tbl` | — |
| G4 | Join/leave funnel per day, per invite link | member events | `tbl` | — |
| G5 | Weekly report file in the library + summary to owner | schedule | `tbl` aggregate, `lib`, `notify` | Generated chart image (optional) |

### H. Reminders / scheduling

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| H1 | Recurring announcement (session open, market open) | schedule cron + tz | `send`, `pin` | Image |
| H2 | "Remind me in 2 h" command in chat | message + regex | `later` with payload, `reply` | — |
| H3 | Event countdown (T-24 h, T-1 h) from an `events` table | schedule or `later` per row | `tbl`, `send` | — |
| H4 | Economic-calendar alerts from an API | schedule | `http`, `send` | — |

### I. Data sync / webhooks

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| I1 | TradingView/exchange alert webhook → formatted signal to channels + row | `webhook` (secret, maybe IP/HMAC) | `send`, `tbl` | Chart snapshot URL → photo |
| I2 | Chat messages → Google Sheets/Notion/CRM | `message.created` | `http` | File links |
| I3 | Table row → external system (outbound webhook) | `row.created/updated` | `http` with retry | — |
| I4 | Nightly import CSV/JSON from URL into a table (upsert) | schedule | `http`, `tbl` upsert | — |
| I5 | App event (task done, alarm) → chat | `app` | `send` | — |

### J. Table-centric automations

| # | Scenario | Trigger | ctx | Media |
|---|---|---|---|---|
| J1 | Status transition: row `status` becomes `approved` → post it | `row.updated` + condition transition | `send`, `tbl` set `postedAt` | Row holds file paths |
| J2 | Derived fields: on write, compute `rr = (tp-entry)/(entry-sl)` | `row.created/updated` (watched fields) | `tbl` update (no self-loop) | — |
| J3 | Rollup: per-provider win rate kept on `providers` rows | `row.updated` on `signals` | `tbl` aggregate + update | — |
| J4 | Approval queue: rows "pending" → owner approves in chat via buttons | `row.created` | `send` with `btn`, `action` → `tbl` update | Preview media |
| J5 | Archive rows older than 90 days to a CSV in the library | schedule | export, `tbl` delete | — |
| J6 | Data quality: nightly find duplicates/missing fields, notify | schedule | `tbl` aggregate, `notify` | — |

That is 60 scenarios.

## 2. Capability checklist

Columns: **Level** (must = common/must-have, nice = nice-to-have), **Now** (✓ ◐ ✗), reason, source.

### 2.1 Triggers

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| `message.created/edited/deleted`, reactions, member join/leave/requests, button `action` | must | ✓ | Base of A–F | — |
| Edited channel posts delivered as `message.edited` | must | ◐ | Signal edit sync (A2); Telegram sends `edited_channel_post` | [Bot API Update](https://core.telegram.org/bots/api#update) |
| Filter: media kind (`text`, `photo`, `video`, `animation`, `sticker`, `voice`, `video_note`, `audio`, `document`, `poll`, `location`, `contact`) | must | ✗ | Moderation locks and routing; Rose has 48 lock types | [Rose locks](https://missrose.org/docs/anti-spam/locks/) |
| Filter: is forwarded + forward origin (user/bot/channel/story) | must | ✗ | Most common anti-spam lock; also copier loop prevention | [Rose locks](https://missrose.org/docs/anti-spam/locks/) |
| Filter: has reply / reply to a message of chat X / reply to self | must | ◐ (`replyTo` in event, no filter) | Follow-up threading (A3, A5), tickets (E3) | — |
| Filter: has link / invite link / mention / hashtag / cashtag (entities) | must | ✗ | Link locks, signal tags (`$BTC`) | [Rose locks](https://missrose.org/docs/anti-spam/locks/) |
| Filter: regex over text **and caption** | must | ◐ (text) | Signals are often captions on a chart photo | — |
| Filter: sender role, specific actors, sender is a channel (anonymous admin / linked channel) | must | ◐ | Mod exemptions for admins; anon posts | — |
| Filter: commands (`/report`, `/faq x`) with args | nice | ◐ (regex) | Regex covers it; dedicated filter is ergonomic | — |
| Album grouping: one event per `media_group_id` with all items (debounce ~1–2 s) | must | ✗ | #1 pain point in Make/n8n; copying item by item breaks albums | [Make forum](https://community.make.com/t/multiple-photos-dowload-from-telegram/93714), [freelance case](https://freelancehunt.com/en/project/consultation-make/1611842.html) |
| `message.deleted` for userbot connections (best effort, documented) | nice | ◐ | Bots never get deletions; MTProto deletions are unreliable | [Telethon events](https://docs.telethon.dev/en/stable/quick-references/events-reference.html) |
| Reaction count updates for channels (anonymous) | nice | ✗ | Post performance (G3); grouped and delayed by Telegram | [Bot API message_reaction_count](https://core.telegram.org/bots/api#messagereactioncountupdated) |
| Join request with invite link used + DM window | must | ◐ | Screening and referral (C3, F5); bot may DM applicant via `user_chat_id` for 5 min | [Bot API ChatJoinRequest](https://core.telegram.org/bots/api#chatjoinrequest) |
| Schedule: cron + tz, every, at | must | ✓ | H1–H4 | — |
| More than one schedule per script | nice | ✗ | Night mode on/off (B8) needs two; workaround: two scripts | — |
| One-shot delayed run (`ctx.later({ in, payload })` → `delayed` event) | must | ✗ | Auto-delete, captcha timeout, VIP delay, reminders (C1, C2, A7, D6, H2) | [Botize delayed copy](https://botize.com/en/formula/753/each-new-message-from-a-telegram-chat-group-or-channel-is-copied-to-another-after-24-hours) |
| Table trigger: watched fields | must | ✗ | Airtable "when record updated" watches chosen fields; avoids noise | [Airtable](https://support.airtable.com/docs/when-record-is-updated-trigger) |
| Table trigger: condition transition ("starts to match") | must | ✗ | Status workflows (J1, E6); fires once per transition | [Airtable](https://support.airtable.com/articles/7369519794-Airtable-automation-trigger:-When-record-matches-conditions), [NocoDB](https://nocodb.com/docs/workflows/nodes/trigger-nodes/record-matches-condition) |
| Table trigger gets old + new values | must | ✗ | Know what changed (status from → to) | [Baserow](https://baserow.io/blog/webhook-trigger-field-changes) |
| Batch rows in one table event | must | ✓ (up to 20) | Baserow does the same | [Baserow triggers](https://baserow.io/user-docs/automation-triggers) |
| Webhook trigger with secret URL | must | ✓ | TradingView / payments (I1, F2) | — |
| Webhook HMAC signature check helper, custom response body/status | nice | ◐ | Stripe/GitHub style providers sign payloads | — |
| App events | nice | ✓ | I5 | — |

### 2.2 ctx operations (channels)

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| `channels.copy({ from, messageIds, to, caption?, replyTo? })` by reference (no re-upload), albums kept | must | ✗ | Core of every copier; avoids 20 MB/50 MB bot file limits and keeps stickers/voice | [copyMessages](https://core.telegram.org/bots/api#copymessages), [getFile limit](https://core.telegram.org/bots/api#getfile) |
| `channels.forward` (with origin) | must | ✗ | Report to admin chat (B6), keeping attribution | [forwardMessages](https://core.telegram.org/bots/api#forwardmessages) |
| Send media from library files incl. albums (2–10 items, docs/audio only grouped with same type) | must | ◐ (`files`) | Scheduled posts (D2); album rules matter | [sendMediaGroup](https://core.telegram.org/bots/api#sendmediagroup) |
| Caption override on copy, caption above media | must | ✗ | Rebranding (A6); captions ≤ 1024 chars vs text 4096 | [copyMessage](https://core.telegram.org/bots/api#copymessage) |
| Formatting: HTML/Markdown or entities; keep source entities on transform | must | ? | Signals use bold/code/links; naive text copy loses them | — |
| Link preview control (off / URL / above) | nice | ✗ | RSS posts, clean signal posts | [LinkPreviewOptions](https://core.telegram.org/bots/api#linkpreviewoptions) |
| Send sticker / animation / voice by file id | must | ✗ | Auto-replies with stickers (E1), welcome GIF | — |
| Inline buttons: URL + callback, edit buttons later | must | ✗ | Captcha, approvals, giveaways, CTAs (C2, J4, F4) | [n8n Telegram node](https://n8n.io/integrations/telegram/) |
| Answer callback (toast/alert) | must | ✗ | Button UX feedback | — |
| `react` incl. custom emoji; remove reaction | nice | ◐ | Engagement (A14); bots limited to existing/allowed custom emoji | [setMessageReaction](https://core.telegram.org/bots/api#setmessagereaction) |
| `edit` text **and caption**, edit media, edit buttons | must | ◐ (text) | Edit sync on media posts (A2) | [editMessageCaption](https://core.telegram.org/bots/api#editmessagecaption) |
| `delete` (incl. many / whole album) | must | ✓ (one) | Moderation, auto-delete; album = several ids | [deleteMessages](https://core.telegram.org/bots/api#deletemessages) |
| `pin` / unpin, silent pin | must | ✓ | D5, H1 | — |
| Moderation: ban/unban, mute/restrict with until, set chat permissions, approve/decline join request | must | ◐ (`channels.action`) | B2–B8, C2–C5; typed methods beat a generic action bag | [restrictChatMember](https://core.telegram.org/bots/api#restrictchatmember), [approveChatJoinRequest](https://core.telegram.org/bots/api#approvechatjoinrequest) |
| Get one member (status, joined, is subscribed) | must | ◐ (`members` list) | Giveaway subscription check, VIP checks | [getChatMember](https://core.telegram.org/bots/api#getchatmember) |
| Invite links: create (per member, with limit/expiry, join request), revoke | must | ◐ (`action`) | Paid access, referrals (F2, F5) | [createChatInviteLink](https://core.telegram.org/bots/api#createchatinvitelink) |
| Polls / quizzes, stop poll, read results | nice | ✗ | CSAT, community votes | [sendPoll](https://core.telegram.org/bots/api#sendpoll) |
| DM a user (by id) when allowed | must | ◐ | Join-request screening, receipts, renewal notices | — |
| Forum topics: post to topic, create topic | nice | ◐ (`topic`) | Groups with topics per pair | — |
| Read message stats (views, forwards) | nice | ✗ | G3 (userbot or channel stats) | [TGStat API (example metrics)](https://cran.nics.utk.edu/cran/web/packages/rtgstat/refman/rtgstat.html) |
| `download` media to library with size limits stated | must | ✓ | Archiving, OCR/STT (D8, D9) | [getFile](https://core.telegram.org/bots/api#getfile) |
| Respect `has_protected_content` (copy refused) with a readable error | must | ✗ | Copying from protected channels fails; must be explained | [Chat](https://core.telegram.org/bots/api#chat) |

### 2.3 State

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| KV get/set/delete/keys | must | ✓ | Conversation state, counters | — |
| KV TTL (expire after) | must | ✗ | "once per user per day", flood windows, captcha state | — |
| Atomic increment / compare-and-set in KV | must | ✗ | Concurrent events race (runs serialize per script, but two scripts share tables) | — |
| Dedupe helper (`ctx.once(key, ttl)`) | must | ✗ | Multi-source merge, webhook retries, RSS (A10, D3, I1) | — |
| Rate limiter helper (sliding window per key) | must | ✗ | Antiflood (B3), per-user command limits | [tg-spam](https://github.com/umputun/tg-spam) |
| Message id map helper (source → copies per target, with album ids) | must | ✗ | A2, A3, A12, E3; every copier reimplements it | [tgcf](https://github.com/aahnik/tgcf) |
| Delayed run with payload (see triggers) | must | ✗ | — | — |
| Random (seeded / crypto) | nice | ? | Giveaways, random delays | [Botmother giveaway](https://botmother.com/templates/giveaway) |

### 2.4 Tables

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| Query/aggregate/insert/update/delete, `inc`, `ifVersion` | must | ✓ | — | — |
| Unique key + `upsert` in ctx and API | must | ◐ (import `upsertKey` only) | Signal by source msg id, order by external id; avoids duplicate rows on retries | [Airtable script limits](https://support.airtable.com/docs/run-a-script-action) |
| Unique constraint enforced by the table | must | ✗ | Dedupe must survive races | — |
| Relations (reference column to another table's row) + simple join/lookup in query | nice | ✗ | signals ↔ providers, tickets ↔ customers; can be done by id fields today | [Airtable lookup](https://support.airtable.com/docs/lookup-field-overview) |
| Rollups (count/sum over related rows, kept fresh) | nice | ✗ | Provider win rate (J3); scripts can compute it | [Airtable rollup](https://support.airtable.com/docs/rollup-field-overview) |
| Formula / computed columns | nice | ✗ | R:R, days open; scripts can compute on write (J2) | — |
| Saved views (filter + sort + columns) in UI, usable as trigger scope | nice | ✗ | People live in views; "record enters view" trigger | [Airtable triggers](https://support.airtable.com/docs/airtable-triggers) |
| Row history / audit (who, when, old → new) | nice | ◐ (`_version`, author) | Disputes on signal results, debugging scripts | — |
| CSV/JSON import (upsert) + export | must | ✓ | — | — |
| Date filters relative to now ("older than 48 h") | nice | ◐ (compute ISO in script) | Expiry jobs (A11, J5) | — |
| File/attachment column (library path + media type) | nice | ✗ | Posts queue, chart images | — |

### 2.5 Observability

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| Run trace with ctx calls, logs, result, duration | must | ✓ | — | — |
| Skipped-run reasons (filters, cooldown, loop) | must | ✓ | — | — |
| Automatic retry of transient send failures (429 `retry_after`, 5xx) with backoff | must | ✗ | Fan-out hits flood limits; lost signals are costly | [Bot FAQ limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) |
| Outbound send queue/outbox (paced per chat, survives restart) | must | ◐ (core `eharness/channels` has an outbox) | 20 msg/min per group, 1 msg/s per chat | [Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) |
| Dead-letter list: failed events re-runnable after a fix | nice | ✗ | Re-send missed signals after a bug fix | — |
| Alerts: auto-disable after N failures, failure notify | must | ✓ | — | — |
| Per-script metrics (runs/day, error rate, p95 duration) | nice | ✗ | Spot a degrading script | — |
| Trace shows media summary (kinds, sizes, album count), not content | must | ◐ | Debug media routing without storing content | — |

### 2.6 Safety

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| Loop guard (own sends, own table writes, own api calls) | must | ✓ | Copier A→B→A loops | — |
| Cross-script loop detection (script X writes table Y that starts X'; chain depth limit) | must | ✗ | Table + channel chains loop through two scripts | — |
| Flood caps per run / per hour / per chat on sends | must | ◐ (runs/hour) | One bug can spam 50 channels; Telegram may restrict the bot | [Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) |
| Dry run (writes recorded) | must | ✓ | — | [tg-spam `--dry`](https://github.com/umputun/tg-spam) |
| Shadow mode: live events, actions only logged (tune moderation before enforcing) | nice | ✗ | tg-spam "training"/"dry" modes; avoids false bans | [tg-spam](https://github.com/umputun/tg-spam) |
| Grants (default deny), approval of widening versions | must | ✓ | — | — |
| Destructive moderation (ban/delete in bulk) needs explicit grant per chat | must | ◐ | Mistaken mass bans are hard to undo | — |
| Userbot caution: limits on actions from a personal account | must | ◐ | Userbot automation risks account restrictions (forwarder sellers advise a spare account) | [Fiverr forwarder gig](https://fiverr.com/ritvikworks/build-a-telegram-auto-forward-bot-to-clone-and-mirror-channels) |
| Freshness window (no catch-up storms after restart) | must | ✓ | — | — |

### 2.7 UX

| Capability | Level | Now | Why | Source |
|---|---|---|---|---|
| Recipes/templates for top scenarios (signal distributor, edit sync, logger, welcome+captcha, antiflood, FAQ, scheduled posts, daily report) | must | ◐ | n8n/Zapier/Botize live on templates | [Botize formulas](https://botize.com/en/formula/441/copy-the-complete-messages-you-post-in-one-chat-group-channel-to-two-other-different-ones) |
| Test with sample events incl. media (photo with caption, album of 3, sticker, voice, forward from channel, reply) | must | ◐ (text typed by hand) | Media routing bugs only show with media events | — |
| Replay a recorded event (metadata) with a fresh text/caption | must | ✓ | — | — |
| Trigger "would match / why not" explanation | must | ✓ | — | — |
| Log viewer with filters (status, trigger, chat) | must | ◐ | — | — |
| Typed `scripts.d.ts` with event unions per trigger and media types | must | ◐ | Editor completion is how non-experts write scripts | — |
| Simple mode (form-built rules without code) for the top recipes | nice | ◐ | Rose-like rules for non-coders | — |
| Signal parser helper (regex templates for pair/side/entry/SL/TP) | nice | ✗ | Formats vary; AI parsing exists in commercial copiers | [MQL5 copier](https://www.mql5.com/en/market/product/183568) |

## 3. Notes per platform constraint

- **Bot API limits**: text 4096 chars, caption 1024, album 2–10 items, bot download 20 MB, upload
  50 MB; ~1 msg/s per chat, 20/min per group, ~30/s global
  ([Bot API](https://core.telegram.org/bots/api), [FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)).
- **Reactions**: `message_reaction` needs the bot to be admin and the update enabled; bot-set
  reactions do not fire it; counts for channels are grouped and delayed
  ([Bot API](https://core.telegram.org/bots/api#messagereactionupdated)).
- **One webhook per bot**: n8n users find only the last activated Telegram trigger gets updates; the
  team app's single gateway per connection avoids this, worth stating in docs
  ([Hostinger n8n guide](https://www.hostinger.com/tutorials/?p=132101)).
- **Privacy mode**: bots in groups only see commands/replies unless privacy mode is off or the bot
  is admin; a script "not firing" is often this (same source).
- **Userbots**: see deletions (unreliably), message views and any chat the account is in; higher
  risk of account limits ([Telethon](https://docs.telethon.dev/en/stable/quick-references/events-reference.html)).

## Sources

- Telegram Bot API: https://core.telegram.org/bots/api ; Bot FAQ limits: https://core.telegram.org/bots/faq
- Rose docs (locks, anti-spam): https://missrose.org/docs/anti-spam/locks/ , https://missrose.org/docs/anti-spam/
- Combot / CAS: https://combot.org/
- tg-spam: https://github.com/umputun/tg-spam
- tgcf (forwarder: filter, replace, caption, watermark, OCR; past/live): https://github.com/aahnik/tgcf
- Telethon events: https://docs.telethon.dev/en/stable/quick-references/events-reference.html
- Botize Telegram formulas (copy, delay, delete after): https://botize.com/en/method/telegrambot/copy_message
- Make album issue: https://community.make.com/t/multiple-photos-dowload-from-telegram/93714
- n8n Telegram node: https://n8n.io/integrations/telegram/ ; Hostinger n8n guide: https://www.hostinger.com/tutorials/?p=132101
- Zapier Telegram integrations: https://zapier.com/apps/telegram/integrations
- Telegram→MT4 copiers: https://www.mql5.com/en/market/product/183568 ; Cornix review: https://gainium.io/review/cornix
- Join-request captcha bot: https://hub.docker.com/r/james58899/tg-recaptcha
- Giveaway bots: https://botmother.com/templates/giveaway
- Airtable: https://support.airtable.com/docs/when-record-is-updated-trigger , https://support.airtable.com/articles/7369519794-Airtable-automation-trigger:-When-record-matches-conditions , https://support.airtable.com/docs/run-a-script-action , https://support.airtable.com/docs/rollup-field-overview
- Baserow: https://baserow.io/user-docs/automation-triggers , https://baserow.io/blog/webhook-trigger-field-changes
- NocoDB: https://nocodb.com/docs/workflows/nodes/trigger-nodes/record-matches-condition , https://nocodb.com/docs/product-docs/automation/webhook/create-webhook
- TGStat API metrics: https://cran.nics.utk.edu/cran/web/packages/rtgstat/refman/rtgstat.html
