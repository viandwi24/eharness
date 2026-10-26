# ADR-0066: Chat channels run without an owning agent

Status: **Accepted** · Date: 2026-10-26

## Context

In the team app every chat connection (a Telegram bot or a Telegram user account) had to be
**bound** to one agent before anything happened. Unbound, the transport did not start: nothing was
recorded, the Channels pages showed only Overview and Settings, and the channel tools
(`channel_read`, `channel_send`, events, history…) existed only for the owning agent.

Owners connect accounts for other reasons too: "connect my Telegram account so agents can read its
chats and send messages for me" without any agent answering on it. Third-party connectors already
work that way: a connection is shared with "all agents" or selected agents on the Connectors page,
and those agents get its tools. Chat connections did not follow the same model.

## Decision

- **A connection runs without an owner.** When no agent is set, the gateway keeps a connection
  config with `agentId: ''` (`NO_OWNER`) and starts the transport. Inbound messages go through the
  usual policy (allowed chats, chosen chats of an account, observe flags) and are **recorded
  observe-only**: stored in the message log, never pending for a wake, never answered. Unknown
  senders get no automatic reply.
- **The owner is optional** ("the answering agent"). It answers direct messages and mentions as
  before. Removing it (the former "unbind") keeps the transport, chats, people and stored messages;
  only the answering stops.
- **Tool access follows the Connectors page.** An agent may use a connection's tools when it owns
  it, owns one of its chats, or the connection's access ("all agents" or selected agents) includes
  it. The gateway asks a `sharedWith(agentId, connectionId)` dependency; the server answers from a
  cache of connector access refreshed when connectors change. An agent with no usable connection
  still gets no channel tools.
- **Scripts** post through a connection with their grants as the check (`resolveTarget(…, { trusted:
  true })`); an owner-less connection posts as the script's agent identity.
- **Web:** every Channels section is shown with or without an answering agent; the overview says
  who can use the tools and links to the Connectors page.

## Consequences

- A connected account starts recording at once, which uses storage and (for a user account) Telegram
  API calls for the chosen chats only; a bot records the chats allowed on the Chats page.
- Access is managed in one place (Connectors) for chat and non-chat connections alike.
- Starting a transport no longer depends on a binding, so a stuck start must not block views: starts
  give up after 20 seconds and retry, and the views wait at most 2 seconds for a sync.
