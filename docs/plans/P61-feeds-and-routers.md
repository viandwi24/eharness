# P61 — Team example: feed chats and router agents

Status: done (2026-10-27) · Owner: agent · Branch: `main` (local commits)

## Goal

An agent can be the "brain" of a chat: it reads every post of a source chat (a feed) and shares
posts out to other chats with its own judgement (the AI way of distributing trading signals),
without being a person's conversation partner. See [routers.md](../../examples/team/docs/routers.md).

## Work

- [x] Feed chats (`feed` chat setting): wake on every message including the account's own posts,
      tool-only delivery, no ack, the agent's own permissions instead of the poster's role, a feed
      session prompt.
- [x] `channel_copy` / `channel_copies` agent tools with a copy map (`ch_copies`): platform copy
      first, download-and-resend as fallback or on request (`via`), follow-ups threaded under
      their copy automatically.
- [x] Edits and deletions of a copied message reach its copies automatically (formatting kept as
      HTML; own captions kept).
- [x] Albums reach the agent as one turn (the inbox collect window) and carry an album id in the
      message header.
- [x] Trial mode per source chat (`copyTrial`): decisions recorded, nothing sent.
- [x] Chat settings: the agent for a chat, feed and trial controls. No router template: what an
      agent does with a feed is its own instructions (a signal-specific template was built and
      removed again: too specific for a generic harness).

## Open

- A connection-agnostic chat settings API for the web (the PATCH route is Telegram connector only).
