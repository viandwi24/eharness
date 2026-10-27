# Feeds and router agents

A **feed** is a chat whose messages are input for an agent: nobody talks to the agent there. A
**router** is an agent on a feed that shares posts out to other chats, for example trading signals
posted in one channel and spread across several others so each gets different signals.

## A feed chat

Chat settings (Channels → a connection → Chats → a chat), or `PATCH
/channels/connections/{id}/chats/{chatId}/policy` with `{ "agentId": "...", "feed": true }`:

- the agent wakes on **every** message, also on what the connected account posts itself (the
  analyst typing on that account from a phone);
- its final text is never posted, and no 👀 ack is put on the posts: it acts only through tools;
- tools run on the **agent's own permissions** (its mode and allow rules), not on the role of
  whoever posted (a channel post has no team role);
- photos sent together (an album) reach it as one turn; each message header carries its message
  id, the message it replies to and its album id.

`copyTrial: true` ("Copies from here: trial") makes `channel_copy` record where it would copy and
send nothing, so a router can run on live traffic before it acts.

## Copying: `channel_copy` and `channel_copies`

`channel_copy({ messageIds, to, toTopic?, replyTo?, caption?, via?, silent?, note? })` copies
messages of the current chat (or `conversation`) to another chat:

- `via: "auto"` (default): the platform's own copy when the connection has one (Telegram
  `copyMessages`: albums, stickers and formatting kept, nothing downloaded); otherwise, or with
  `via: "resend"`, the gateway downloads the files and posts text and files again (works across
  connections with `toConnection`; with `caption` it posts a rewritten text). `via: "native"`
  refuses rather than fall back.
- a follow-up is threaded on its own: when the first message replies to one that was copied to the
  same chat, the copy answers that copy;
- every copy is remembered (`ch_copies`): **edits and deletions of the original reach its copies
  automatically** (an edit keeps bold, links and code; a copy with its own `caption` keeps it).

`channel_copies({ messageId })` tells where a message went (trial rows too) or what a copy came
from.

## The Signal Router template

Channels → a connection → **Router**, or `POST /channels/connections/{id}/signal-router` with
`{ source, targets, name?, trial?, table?, rules? }`, sets up:

- an agent "Signal Router" with instructions for signal channels (what a new signal, an early entry
  — "cicil", "cent akun buy dulu" — a follow-up — reply, "TP all", "cut loss", screenshots — and
  other posts look like; default TP1/TP2/TP3 of 20/60/100 pips; send each new idea to the target
  with the fewest ideas today; keep follow-ups with their idea; never copy reports or promos) and
  allow rules for `channel_copy`, `channel_copies`, `channel_read`, `tables_read`, `tables_write`;
- a table `trade_ideas` (idea, direction, channel, status, entry, sl, tp, opened_at, last_message,
  reason; `idea` unique);
- the source chat as a feed of the agent, **in trial mode**, and the target chats allowed.

Everything is ordinary afterwards: edit the agent's instructions, the table, or switch the source
chat to live ("Copies from here: sent") in its chat settings.

### What the analyst can do to help

- send follow-ups as replies to their signal ("TP1 hit", "entry now", "cut loss");
- start a new signal with a steady marker (`🟢 BUY` / `🔴 SELL`, or `#signal`);
- write results as replies ("TP1 +30 pips"): the table can then report per target chat;
- post a signal as a new message, not by editing an old chat message.

### Limits

- A source chat with **protected content** ("restrict saving content") cannot be copied or
  downloaded by anyone: Telegram refuses it.
- The connection must be an admin of each target channel, and a member (account) or admin (bot) of
  the source.
- A message posted before the router existed has no copy: a reply to it is decided like a new
  message.
- Speed: a model turn per message (a few seconds; more with several tool calls). Use a fast model
  for the router agent.
