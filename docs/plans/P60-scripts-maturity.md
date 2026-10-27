# P60 — Team example: scripts and tables, mature

Status: in progress (W1–W3 done) · Owner: agent · Branch: `main` (local commits, one gate per step)

## Goal

Scripts and tables handle the real automations of Telegram communities and signal channels, media
included, without workarounds: copy a signal post with its photo or album to other channels,
thread follow-ups under each copy, sync edits, moderate, onboard, answer FAQs, log and report.

Inputs: the scenario catalog and capability checklist in
[docs/research/scripts-scenarios.md](../research/scripts-scenarios.md) and the transport audit
(below). Builds on [P59](P59-scripts-and-tables.md), ADR-0065 and ADR-0066.

## What the audit found (2026-10-26)

- Inbound media is reduced to four kinds (`image`, `file`, `audio`, `video`): stickers, video notes,
  location, venue, contact, poll and dice are dropped by the bot and arrive empty from the user
  account; GIF, video note and video cannot be told apart; voice looks like audio.
- Albums are separate events; `media_group_id` / `grouped_id` is never read.
- Captions keep entities on the bot (scripts do not see them); the user account loses them.
- The bot has no `fetchAttachment` (downloading fails), and no file id is stored to resend media.
- Outbound: no stickers, voice, animation or video note sends; videos from the user account go out
  as documents; captions lose formatting; `replyTo` is dropped when files are sent; no `silent`.
- Native copy / forward exist only as transport actions (bot `chat_messages`, user `copy_message`,
  `forward_message`); user copy splits albums.
- Reactions: standard emoji only; channel reactions never arrive (bot); none inbound (user account).
- Script events lack `entities`, `forwardOf`, `threadRoot`; triggers cannot filter on media.

## Work

### W1 — Media model (both transports)
- [x] Attachment kinds: `photo`, `video`, `animation`, `video_note`, `voice`, `audio`, `document`,
      `sticker` (with emoji, set, animated/video flags), plus message kinds `location`, `venue`,
      `contact`, `poll`, `dice` as structured fields; nothing silently dropped.
- [x] Albums: `groupId` on messages; the gateway collects an album (short wait) and delivers one
      script event with all items and the caption.
- [x] Reusable file references: the bot stores `file_id`, the account the message id, so media is
      sent again without a download; the bot gets `fetchAttachment`.
- [x] Entities on captions for both transports; scripts receive `entities`, `forward`, `topic`.
- Notes: the user account's reference is the message itself (resend by copying it, W2); the topic
  stays in `chat` (`rootNativeId` is the group). Lines the agent reads name the media
  (`[sticker 🚀]`, `[3 photos]`). The bot normalizer is version 3.

### W2 — Sending media and copying
- [x] `ctx.channels.send` with `media: [{ kind, file | ref }]` (photo, video, animation, voice,
      video note, document, sticker), captions with formatting (`format: 'markdown' | 'html' | 'plain'`),
      albums, `silent`, `buttons`, `replyTo` with files, link preview on/off.
- [x] `ctx.channels.copy` and `ctx.channels.forward`: by reference, albums kept, caption override,
      returns the new message ids per item.
- [x] Copy map helper: `ctx.channels.copies` keeps source → copies (per target) so replies, edits
      and deletes follow each copy.
- [x] Edit captions and media; delete in bulk.
- [x] Reactions: custom emoji out (both transports) and in (bot, `customEmojiId` on the event).
- [ ] Inbound reactions on the user account and anonymous reaction counts of channel posts (bot
      `message_reaction_count`): need a counts event type; open.
- Notes: buttons on sends land with W4 (callbacks). Edits of the media itself (replace the photo)
  are not offered; captions are. Grants match a chat by id or title either way. A dry run checks
  grants. A user account's own echo during a send is never taken as typed by the person.

### W3 — Triggers and state
- [x] Channel trigger filters: media kinds, has reply, is forward (and from where), has link,
      caption regex, edited.
- [x] `ctx.later({ in | at, event })`: one-shot delayed runs (durable, multi-instance).
- [x] KV with TTL, atomic increment, `ctx.once(key, ttl)` dedupe, sliding-window rate limiter.
- [x] Send pacing with retries on 429 / 5xx for fan-out (through the outbox).
- Notes: names as shipped: `ctx.later({ in | at, data, key })`, `ctx.cancelLater`, `ctx.listLater`,
  `ctx.kv.once`, `ctx.kv.incr`, `ctx.kv.rateLimit`, `ttlSec` on `kv.set`. Only 429 is retried (a
  5xx or network failure may have delivered the message: no blind resend). Later runs are claimed
  by deleting the row (at most once across instances); a run is dropped when its script is no
  longer active. Edits are a trigger already (`message.edited`).

### W4 — Moderation and interaction
- [ ] Typed moderation: ban, mute/restrict with an end, set permissions, approve/decline join
      requests, member lookup, invite links (wrapping the native actions).
- [ ] Buttons and callbacks: send inline buttons, a `callback` trigger, answer and edit buttons.

### W5 — Tables
- [ ] Unique keys and `upsert` in `ctx.tables` and the API.
- [ ] Table triggers on field changes and "starts to match", with old and new values.
- [ ] Nice-to-have: relations and rollups, saved views.

### W6 — Safety, observability, UX
- [ ] Chain loop detection across scripts; caps on sends per run and per chat; a "log only" mode.
- [ ] Failed events list with re-run.
- [ ] Test panel with sample media events (photo + caption, album, sticker, voice, forward, reply).
- [ ] Recipes: signal distributor with reply/edit sync, signal logger and outcome tracker, welcome
      + captcha, antiflood and locks, FAQ, scheduled posts, daily report.

## Acceptance

- [ ] A signal with a photo (and an album of 3) in channel #1 is copied, with its formatted caption,
      to #2 or #3 by the balancer recipe; "TP hit" replies thread under the right copy; an edit in
      #1 updates the copy; no download of large media.
- [ ] A sticker, a voice note and a poll each reach a script with their kind and can be resent.
- [ ] Full gate green; docs (`examples/team/docs/scripts.md`) updated.
