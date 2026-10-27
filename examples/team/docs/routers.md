# Feeds and router agents

A **feed** is a chat whose messages are input for an agent: nobody talks to the agent there. What
the agent does with them is up to **its instructions**, which you write: share posts out to other
chats, summarise them, keep a log in a library file or a table, alert someone. There is no special
router feature: a router is just an agent of your own on a feed chat.

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

## Setting one up

1. **Agents → New agent.** Write its instructions in your own words, for example: "Every new
   signal in this chat goes to VIP 1 or VIP 2, whichever got fewer today. Replies and follow-ups go
   where their signal went. Skip greetings and promos. Track every signal in
   /library/signals/log.md (id, direction, where it went, status)."
2. On the agent page: **Connectors → Files**, edit on (for a library log file), and in
   **Permissions** allow the tools it runs without asking (`channel_copy`, `channel_send`,
   `write_file`, `edit_file`, `tables_write`…). Pick a fast model.
3. **Channels → a connection → Chats → the source chat**: *Agent for this chat* = that agent,
   *Feed for its agent* = a feed, *Copies from here* = trial to watch it first.
4. Allow the target chats (the agent may post only where the agent is allowed).
5. Check what it decided (its chat session in Inbox, `channel_copies`, its log file), then switch
   *Copies from here* to sent.

Any tool the agent has works on a feed: `channel_copy` / `channel_send` to post, the file tools or
`tables_write` for its memory, `channel_read` to look back.

### Example: trading signals — what the analyst can do to help

- send follow-ups as replies to their signal ("TP1 hit", "entry now", "cut loss");
- start a new signal with a steady marker (`🟢 BUY` / `🔴 SELL`, or `#signal`);
- write results as replies ("TP1 +30 pips"): the table can then report per target chat;
- post a signal as a new message, not by editing an old chat message.

### Limits

- A source chat with **protected content** ("restrict saving content") cannot be copied or
  downloaded by anyone: Telegram refuses it.
- The connection must be an admin of each target channel, and a member (account) or admin (bot) of
  the source.
- A message posted before the agent was on the feed has no copy: a reply to it is decided like a
  new message.
- Speed: a model turn per message (a few seconds; more with several tool calls). Use a fast model.
