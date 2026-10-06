# Group chat

`eharness/group` puts an agent in a multi-party chat: it answers only when addressed, still sees
what it missed, and does not get stuck in a bot-to-bot loop. Contract:
[spec 16](../specs/16-group-plugin.md). Runnable: [`examples/group-chat.ts`](../../examples/group-chat.ts).

## Setup

```ts
import { defineHarnessAgent } from 'eharness'
import { groupChat, routeGroupMessage } from 'eharness/group'

const group = groupChat({ botId: 'bot-123', botName: 'Harness' })
const agent = defineHarnessAgent({ model, plugins: [group] })

// one session per chat; acceptClientMetadata keeps the speaker (`metadata.group`) in storage
const session = agent.session(`telegram:${chatId}`, { acceptClientMetadata: true })

const result = await routeGroupMessage(group, session, {
  text,
  author: { id: String(from.id), name: from.first_name, isBot: from.is_bot },
  mentionsBot, // the channel adapter's fact
  replyToBot,
  chatId,
  messageId,
})
if (result.responded) {
  for await (const chunk of result.run.stream) { /* send to the chat */ }
}
```

The agent answers when `mentionsBot` is set, when `replyToBot` is set (`replyCountsAsMention`), or
when the text matches `mentionPatterns` (or `@botName`). Everything else is stored as a
`group.message` kind (visible to your UI, never sent to the model alone) and handed to the model —
the newest `historyLimit` (default 20), framed as data — with the next answer, exactly once.

## Wiring sketches

**Telegram** (grammY): `mentionsBot` = a `mention` entity equal to `@yourbot` in `ctx.msg.entities`;
`replyToBot` = `ctx.msg.reply_to_message?.from?.id === ctx.me.id`; `author.isBot = ctx.from.is_bot`.

**Slack** (Bolt): `mentionsBot` = `event.type === 'app_mention'` or text containing `<@${botUserId}>`;
`replyToBot` = a thread whose parent was posted by the bot; use `chatId = event.channel`.

Streaming the answer back and splitting long messages is channel code; the plugin only decides and
shapes the model input.

## Several bots in one channel

Bot authors are ignored (`reason: 'bot'`) unless you opt in with `allowBots: true` or a list of ids.
Allowed bots count toward `maxBotTurns` (default 3 per 60 s): over the limit the message is stored
as context and not answered (`reason: 'loop-limit'`). The count is derived from stored history, so it
works across instances sharing storage — but it needs `acceptClientMetadata: true`; without it the
plugin logs one warning. Humans are never limited.

## Custom policy

`shouldRespond(message, { mentioned, session })` returns `'respond'`, `'ignore'` or `'default'`
(continue with the rules): e.g. always answer in a 1:1 chat, never answer in a muted channel, or
call a cheap model to decide whether to chime in. Relevance scoring and persona stay in your code.

## Bursts

`routeGroupMessage` sends with `ifBusy: 'collect'`, so messages arriving during a turn merge into
one queued turn (tune with `{ collect: { quietMs } }` in the send options). Ignored messages never
enter the queue.

## Summaries

A long chat is compacted like any session (see [Context and compaction](compaction.md)); for a
rolling summary of who said what, use [`eharness/memory`](memory.md).
