# ADR-0031: Group chat as a plugin plus a helper outside the turn

Status: **Proposed** · Date: 2026-10-06 · Builds on: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0011](0011-stored-order-equals-model-order.md)

## Context

In a group chat an agent should not answer every message. Prior art (OpenClaw `requireMention`,
ElizaOS `shouldRespond`, Teams mention-only bots, AutoGen `max_round`) gates per message, keeps
what was skipped as context and caps bot-to-bot exchanges. Three design questions: where the gate
runs, how skipped messages reach the model, and where the loop counter lives.

## Decision

- **Gate outside the turn.** `routeGroupMessage` decides before `send()`. Gating inside
  `input.submit` would need a `block`: without `persist` the skipped message is lost, with
  `persist` it becomes an `eh.notice` per message. A helper can store a purpose-built kind
  (`group.message`, `model: 'omit'`) and never enqueues a turn it will not run.
- **Merge, do not project, the history.** Projecting every `group.message` kind keeps all of them
  in context until compaction and cannot bound the count. The newest `historyLimit` pending
  messages are instead merged into the answering user message (framed as data, tags neutralised).
  The text is duplicated in storage (kind + merged copy) but stored order equals model order
  (ADR-0011) and cost is bounded.
- **Derive the anti-loop from history.** The count of bot-triggered turns is read from stored user
  messages (`metadata.group.author.isBot`, `createdAt`) in the window; no plugin state, so it is
  multi-instance safe. It needs `acceptClientMetadata: true`; without it the plugin warns once and
  degrades (the speaker line stays, the counter is blind).
- **The plugin carries its configuration.** `groupChat()` returns the plugin with a `route`
  method; `routeGroupMessage(group, session, …)` is a thin alias. A helper that only had the
  session could not know the options. `shouldRespond` receives `{ mentioned, session }` (there is
  no turn context outside a turn).
- **Gated file contents are not stored in the kind**; only names and media types. History carries
  `[attached: name]`.

## Consequences

- No core change. Hard rule 2 holds: `UIMessage` + app metadata key `group` + one plugin kind.
- A burst routed concurrently with a still-starting turn may repeat a gated message once (best
  effort, documented in spec 16 §5).
- Applications keep channel parsing, relevance and persona policy (`shouldRespond`).
