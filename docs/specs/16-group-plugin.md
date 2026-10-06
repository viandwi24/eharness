# Spec 16 — Group-chat plugin (`eharness/group`)

Status: **Draft (0.5)**. Module: `src/group/*`. Built only with the public core API (ADR-0008).
Design: [ADR-0031](../decisions/0031-group-chat-helper-outside-the-turn.md).

A session can sit in a multi-party chat (Discord, Telegram, Slack, a WhatsApp group, several bots
in one channel). The plugin decides **per incoming message** whether the agent answers, keeps what
it did not answer as context for the next answer, carries the speaker on the user message and
stops bot-to-bot loops. Channel adapters (Telegram entities, Slack events, reply detection) stay
in the application: it reports facts (`mentionsBot`, `replyToBot`); the plugin decides.

No new message type: everything is a `UIMessage`, metadata (`metadata.group`) and one plugin kind
(`group.message`, `model: 'omit'`).

## 1. API

```ts
import { groupChat, routeGroupMessage } from 'eharness/group'

const group = groupChat({ botId: 'bot-123', botName: 'Harness' })
const agent = defineHarnessAgent({ model, plugins: [group] })
const session = agent.session(chatId, { acceptClientMetadata: true })

const result = await routeGroupMessage(group, session, {
  text, author: { id, name, isBot }, mentionsBot, replyToBot, chatId, messageId,
})
if (result.responded) for await (const chunk of result.run.stream) { /* … */ }
```

```ts
interface GroupAuthor  { id: string; name?: string; isBot?: boolean }
interface GroupMessage {
  text: string; files?: FileUIPart[]; author: GroupAuthor
  mentionsBot?: boolean; replyToBot?: boolean
  chatId?: string; messageId?: string; at?: number
}
interface GroupChatOptions {
  botId: string                                   // own author id: own messages are dropped
  botName?: string                                // `@name` is a default mention pattern
  requireMention?: boolean                        // default true
  mentionPatterns?: RegExp[]                      // text fallback; flags g/y are ignored
  replyCountsAsMention?: boolean                  // default true
  historyLimit?: number                           // default 20; 0 = none
  maxBotTurns?: { count: number; windowMs: number } // default { 3, 60_000 }
  allowBots?: boolean | string[]                  // default false
  shouldRespond?: (m: GroupMessage, e: { mentioned: boolean; session: GroupSession })
    => 'respond' | 'ignore' | 'default' | Promise<…>
  formatSpeaker?: (a: GroupAuthor) => string      // default name ?? id
}
type GroupRouteResult =
  | { responded: false; reason: 'not-mentioned' | 'bot' | 'loop-limit' | 'ignored'; messageId: string | undefined }
  | { responded: true; run: HarnessRun }
```

`groupChat()` returns a `HarnessPlugin<'group'>` that also has a `route(session, message, sendOptions?)`
method; `routeGroupMessage(group, session, message, sendOptions?)` is the same call as a function.
`GroupSession` is the structural part of a session the plugin uses (`send`, `messages`, `inject`);
any `HarnessSession` fits. The plugin defines the kind `group.message` (§3) and one hook
(`input.submit`, §6); the rest happens in `route`, **outside** the turn (ADR-0031).

## 2. Decision order (normative)

For one incoming message:

1. **Own message** (`author.id === botId`) → dropped, nothing stored, `{ responded: false,
   reason: 'ignored', messageId: undefined }` (it is already in the conversation as assistant text).
2. **Bot author not allowed** (`author.isBot` and not `allowBots === true` / listed by id) →
   `'bot'`.
3. `shouldRespond(message, { mentioned, session })`: `'respond'` and `'ignore'` (→ `'ignored'`)
   are final; `'default'` or no hook continues.
4. **Mentioned** — `mentionsBot`, or `replyToBot` while `replyCountsAsMention`, or a
   `mentionPatterns` / default `@botName` match on `text` → respond.
5. Otherwise `requireMention` (default) → `'not-mentioned'`, else respond.
6. If the message would be answered **and** its author is a bot: the anti-loop (§4) may still
   ignore it (`'loop-limit'`).

Every ignored message except rule 1 is stored (§3) and returned with its `messageId`.

## 3. Gated-out messages and history

Ignored messages are stored with `session.inject('group.message', data)`: a kind message
(`model: 'omit'`, default `next-turn` delivery, no wake), visible to UIs, never sent to the model
on its own. Data: `{ author, text, files?: [{ mediaType, filename? }], chatId?, messageId?, at? }`
— file **contents are never stored** in the kind (only names/types).

When a message is answered, the helper builds **one user message**:

```
<GROUP_HISTORY_PREAMBLE>
<group-message author="Bob">…</group-message>        ← newest historyLimit pending, oldest first
…

[group] Alice: the message text
```

- **Pending** = the `group.message` kinds the model has not seen (newest 200 messages scanned),
  the newest `historyLimit` of them shown. With speaker metadata kept (`acceptClientMetadata`),
  "seen" means the kind's id is in `metadata.group.consumed` of a stored answering user message
  (the helper lists every pending id there, also those cut by `historyLimit`); so a gated message
  stored while a turn runs, or between the routing and the commit of another message, is never
  lost and reaches the model exactly once. Without client metadata the older rule applies: the
  `group.message` kinds after the newest non-kind (user or assistant) message. Stored order =
  model order (ADR-0011).
- A burst: ids a routed message claimed stay claimed in memory (per session handle) until its turn
  ended, so messages collected into one queued turn carry **one** history block, not one each. A
  turn that failed before storing offers its claimed messages again.
- Text a sender typed is neutralised: a line starting with `[group] ` becomes `[ group] `, so a
  message cannot pose as another speaker.
- History text is data: `<group-message` / `<system-reminder` tags in it are neutralised
  (`<` → `&lt;`, as in spec 14 §4) and author names are attribute-escaped. File names appear as
  `[attached: name]`.
- `GROUP_HISTORY_PREAMBLE` and the `[group] ` speaker-line prefix (`GROUP_SPEAKER_PREFIX`) are
  exported, model-visible fixed texts; changing them is a minor change.
- Speaker facts go to `metadata.group = { author, chatId?, messageId?, consumed? }` of the user message. This
  uses client metadata: the session must be opened with **`acceptClientMetadata: true`** (spec 05
  §1). Without it the metadata is dropped (the visible speaker line remains); with `allowBots`
  enabled the `input.submit` hook then logs one warning, because the anti-loop (§4) cannot see
  bot authors. `messageId` becomes the client id (`metadata.eharness.clientId`); the stored id is
  server-generated.
- Convention (spec 03 §3): app metadata keys are free-form; `group` is the key used by this plugin.

## 4. Anti-loop

A message from an allowed bot that would be answered counts toward `maxBotTurns`: the helper counts
**stored user messages** with `metadata.group.author.isBot === true` and
`metadata.eharness.createdAt` inside `windowMs` (newest 200 scanned). `count` or more →
`'loop-limit'` (message stored per §3). Humans are never limited. No state is written: the count
derives from history, so instances sharing storage agree and a restart changes nothing. Cost: the
helper reads the newest 200 messages per answered message.

## 5. Busy sessions and multi-instance

- The helper sends with `ifBusy: 'collect'` unless the caller overrides it (chat bursts merge into
  one queued turn, spec 05 §12 rule 6). Gating happens **before** enqueueing, so an ignored message
  never occupies the queue.
- History is built at routing time from the stored `consumed` ids plus the in-memory claims of
  §3: concurrent routing neither loses nor repeats a gated message inside one process. Two
  instances routing the same session at the same moment (no lock) can still repeat one block.
- The decisions need no lock; two instances produce the same decisions from the same storage
  (apart from the process-local warn-once flag and claims).
- `acceptClientMetadata: true` lets a client of the same session forge `metadata.group`
  (`author.isBot`, `consumed`) on its own messages; route group traffic through your server and do
  not expose the session to untrusted clients with it enabled.

## 6. Hook

`input.submit` (observe only): logs once (`ctx.log.warn`) when a message carrying the speaker line
has lost its `metadata.group` and `allowBots` is enabled (§3).

## 7. Out of scope

Rolling summaries of long chats (use `eharness/memory` or compaction), relevance scoring and
"when to chime in" policy (use `shouldRespond`), persona, per-channel mention parsing and message
formatting for a channel (application code).

## 8. Errors

`route` throws what `session.inject()` / `session.send()` throw (`EH_SESSION_BUSY` only with a
non-default `ifBusy`, `EH_SESSION_CLOSED`, `EH_STORAGE`). Gating never throws for expected
outcomes; they are `responded: false` results.
