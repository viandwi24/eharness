# P27 — Group-chat plugin (`eharness/group`)

Status: in progress · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art item **#5** (verdict GENERIC-plugin, partly: should-respond gating, pending
history of gated-out messages and bot-to-bot anti-loop are generic — OpenClaw `requireMention` /
`mentionPatterns` / reply-as-mention / `historyLimit`, ElizaOS `shouldRespond`, AutoGen
`max_round`, Teams @mention-only bots, Slack Bolt thread context. Rolling summary is the memory
plugin's job; relevance scoring, persona and "when to chime in" stay app policy).

Process (0.5.0): develop first, one gate at the end of the phase, consolidated review at the end
of the release.

## Goal

A session can sit in a multi-party chat (Discord, Telegram, Slack, WhatsApp group, several bots in
one channel). `eharness/group` decides per incoming message whether the agent answers
(`requireMention`, `mentionPatterns`, `replyCountsAsMention`, a custom `shouldRespond`), stores
gated-out messages as non-model kind messages and hands the newest `historyLimit` of them to the
model when it does answer, carries the speaker on the user message without a parallel message type
(`UIMessage` metadata + a visible speaker line), and stops bot-to-bot loops (`maxBotTurns` per
window, bot authors ignored unless allowed). Channel adapters (Telegram entities, Slack events)
stay in the app.

## Specs / docs to read

- `docs/specs/03-messages.md` §3 (metadata, app keys, `acceptClientMetadata`), §5 (message kinds,
  projection `model: 'omit'`, `inject`)
- `docs/specs/05-session-and-storage.md` §1 (`acceptClientMetadata`), §2 (`send`, `ifBusy`), §3
  steps 7–8 (normalization, `input.submit` block / context), §12 (`enqueue` collect for bursts)
- `docs/specs/11-interaction.md` §6 (steer / queue / collect)
- `docs/specs/01-agent-and-plugins.md` §2 (`definePlugin`, kinds), §5 (`input.submit`)
- `docs/specs/14-memory-plugin.md` (rolling summary lives there — out of scope), §4 (framing)
- ADR-0011 (stored order = model order), ADR-0007, ADR-0008
- `src/todos/**` / `src/memory/**` (plugin layout), `scripts/check-imports.ts`, `tsdown.config.ts`,
  `scripts/smoke.mjs`

**AI SDK:** none beyond `UIMessage` metadata (unchanged in 7.0.128,
`https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md`). Prior-art URLs:
`https://docs.openclaw.ai/groups`, `https://docs.elizaos.ai/plugins/bootstrap/complete-documentation`,
`https://docs.ag2.ai/docs/user-guide/basic-concepts/ending-a-chat`. **No devDependency bump.**

## Owns

`src/group/**` (new subpath `eharness/group`), `docs/specs/16-group-plugin.md` (new), ADR-0031
(only if a core rule changes; otherwise none), `package.json` `exports`, `tsdown.config.ts`,
`scripts/check-imports.ts`, `scripts/smoke.mjs`, `CLAUDE.md` (rule 4 list + layout),
`docs/guides/group-chat.md` (new), `examples/group-chat.ts` (new).

## Design

```ts
import { groupChat, routeGroupMessage } from 'eharness/group'

export interface GroupAuthor { id: string; name?: string; isBot?: boolean }
export interface GroupMessage {
  text: string
  files?: FileUIPart[]
  author: GroupAuthor
  /** Channel-level facts the adapter already knows. */
  mentionsBot?: boolean              // e.g. Telegram entity / Slack <@U…>
  replyToBot?: boolean               // reply to one of the bot's messages
  chatId?: string; messageId?: string; at?: number
}

groupChat({
  botId: string, botName?: string,
  requireMention?: boolean            // default true
  mentionPatterns?: RegExp[]          // text fallback, e.g. [/\b@?mybot\b/i]
  replyCountsAsMention?: boolean      // default true
  historyLimit?: number               // default 20 gated-out messages handed to the next reply; 0 = none
  maxBotTurns?: { count: number; windowMs: number }   // default { count: 3, windowMs: 60_000 }
  allowBots?: boolean | string[]      // default false: messages from bots never trigger
  shouldRespond?: (m: GroupMessage, e: { mentioned: boolean; ctx }) => 'respond' | 'ignore' | 'default' | Promise<…>
  formatSpeaker?: (a: GroupAuthor) => string           // default `${name ?? id}`
}): HarnessPlugin        // name 'group'; defines kind 'group.message' (model: 'omit')

routeGroupMessage(session, message: GroupMessage, opts?: SendOptions)
  : Promise<{ responded: false; reason: 'not-mentioned' | 'bot' | 'loop-limit' | 'ignored'; messageId: string }
           | { responded: true; run: HarnessRun }>
```

Normative rules (spec 16):

1. **Decision order**: bot author not allowed → ignore (`'bot'`); `shouldRespond` →
   `'respond'` / `'ignore'` are final, `'default'` continues; mentioned (`mentionsBot`,
   `replyToBot` when `replyCountsAsMention`, or a `mentionPatterns` match) → respond; else
   `requireMention ? ignore : respond`. Then the anti-loop check (rule 4) may still ignore.
2. **Gated-out messages** are stored with `session.inject('group.message', { author, text,
   files?, chatId?, messageId?, at })` (kind message, `model: 'omit'`, default `next-turn`
   delivery, no wake) — no side tables, visible in history for UIs.
3. **Answering** sends one user message built by the helper: the newest `historyLimit`
   `group.message` entries since the last assistant message, framed as data
   (`GROUP_HISTORY_PREAMBLE` + `<group-message author="…">…</group-message>` blocks, tags
   neutralised like spec 14 §4), followed by the speaker line and the message text. Because the
   history is **inside** the stored user message, stored order = model order (ADR-0011). Speaker
   facts go to `metadata.group = { author, chatId?, messageId? }` (requires
   `acceptClientMetadata: true`; without it the helper warns once and keeps only the visible
   speaker line).
4. **Anti-loop**: a message from a bot (when allowed) counts toward `maxBotTurns`; the helper
   counts the agent's turns triggered by bot-authored user messages within `windowMs` from the
   stored history (`metadata.group.author.isBot` + `createdAt`), so it works across instances
   without new state. Over the limit → ignore (`'loop-limit'`, stored as rule 2).
5. **Busy sessions**: the helper sends with the caller's `ifBusy` (default `'collect'` — chat
   bursts merge, spec 05 §12 rule 6); gating happens before enqueueing.
6. **Out of scope**: rolling summaries (use `eharness/memory` or compaction), relevance scoring,
   persona, per-channel mention parsing.

## Checklist

- [x] Spec 16 (rules 1–6, options, fixed texts `GROUP_HISTORY_PREAMBLE`); spec 03 §3 note on the
      `group` app metadata key convention.
- [x] Decide open question 1 (projection vs merge) with a quick test against the projection
      goldens; record it here.
- [x] Plugin + helper in `src/group/` importing core only via `src/index.ts`; kind
      `group.message` with a schema.
- [x] Subpath wiring: `exports['./group']`, tsdown entry `group/index`, `check-imports`
      `subpaths`, smoke exports, CLAUDE.md rule 4 + layout.
- [x] Tests: decision table (mention, reply, pattern, requireMention off, shouldRespond
      overrides, bot authors, allowBots list); gated messages stored as kind and omitted from the
      model; answer carries the newest `historyLimit` entries in order and they appear once;
      framing neutralises an injected `</group-message>`; anti-loop across two simulated
      instances sharing storage; `ifBusy: 'collect'` merges a burst; speaker metadata kept with
      `acceptClientMetadata`, warning without.
- [x] `examples/group-chat.ts` (offline: two humans and a bot) in `examples.test.ts`; guide
      `docs/guides/group-chat.md` (Telegram / Slack wiring sketches, multi-bot channels).
- [x] Changeset; board; gate (incl. `build` + `check:package`).

## Acceptance criteria

- [x] With defaults, the agent answers only when mentioned or replied to, and sees the messages it
      missed (bounded by `historyLimit`) exactly once, in order.
- [x] Two bots in one channel cannot exceed `maxBotTurns` per window.
- [x] No new message type: everything is `UIMessage` + metadata + one plugin kind.
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New subpath `eharness/group`: `groupChat()` plugin (should-respond gating, mention patterns,
  reply-as-mention, `shouldRespond` hook, pending history with `historyLimit`, bot-to-bot
  anti-loop) and `routeGroupMessage()`; kind `group.message`.

## Open questions

1. **History delivery**: project `group.message` kinds directly (simple, but every gated message
   stays in context until compaction and `historyLimit` cannot be applied by a projection) or
   merge the newest N into the answering user message (bounded, duplicated in storage)? Pick:
   **merge** (bounded, ADR-0011 holds); kinds are `model: 'omit'`.
2. **Gating inside `input.submit`** instead of a helper? A block without `persist` stores nothing
   and with `persist` stores an `eh.notice` per ignored message. Pick: helper outside the turn;
   the plugin's hooks only format.
3. **`acceptClientMetadata` requirement** for speaker metadata. Pick: warn and degrade (visible
   speaker line only) rather than fail.
4. **Anti-loop state**: derived from history (no state writes) vs plugin state counter. Pick:
   derived from history (multi-instance safe; bounded scan of the newest 200 messages).

**Decisions / deviations (implementer):**

- Q1 merge confirmed (spec 16 §3, ADR-0031); not tested against projection goldens since no core
  projection changed (kinds are `model: 'omit'`).
- The helper needs the plugin's options, so `groupChat()` returns the plugin with a `route`
  method and `routeGroupMessage(group, session, message, opts?)` takes the plugin first (the
  design block had no `group` argument). `shouldRespond` gets `{ mentioned, session }` instead of
  `ctx` (no turn context outside a turn).
- `botName` adds a default `@botName` mention pattern (case-insensitive).
- The bot's own messages (`author.id === botId`) are dropped and not stored.
- Gated kinds store file names/types only, never contents.
- The speaker-metadata warning is `ctx.log.warn` from `input.submit` (no new `W_*` code), only
  when `allowBots` is enabled (otherwise the anti-loop is moot).
- The framing helper (`neutralizeTags`) is local to `src/group`, not lifted to core (P24 not landed).
- Acceptance criterion "no new message type" holds; "bots cannot exceed maxBotTurns" is tested
  across two instances sharing storage.

## Requests to other phases

- P24: reuse the shared framing helper lifted to core (if P24 lands first; otherwise lift it
  here and P24 reuses it).
- P29: guide index, README plugin list, results table row #5.

## Dependencies

None hard. Wave W4, in parallel with P28 (no file overlap except subpath wiring files — commit
those separately).
