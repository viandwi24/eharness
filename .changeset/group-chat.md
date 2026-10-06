---
"eharness": minor
---

New subpath `eharness/group`: `groupChat({ botId, … })` and `routeGroupMessage()` — multi-party
chat support (spec 16, ADR-0031).

- **Should-respond gating:** `requireMention` (default), `mentionsBot` / `replyToBot` channel
  facts, `mentionPatterns`, `replyCountsAsMention`, a custom `shouldRespond` hook; bot authors are
  ignored unless `allowBots`.
- **Pending history:** gated-out messages are stored as the `group.message` kind (`model: 'omit'`)
  and the newest `historyLimit` (default 20) are merged, framed as data, into the next answering
  user message — exactly once, in order.
- **Speaker metadata** in `metadata.group` (needs `acceptClientMetadata: true`) and a visible
  speaker line; **bot-to-bot anti-loop** (`maxBotTurns` per window) derived from stored history,
  safe across instances.
- Exported texts `GROUP_HISTORY_PREAMBLE`, `GROUP_SPEAKER_PREFIX`. No core change.

Review fixes: pending history is tracked with `metadata.group.consumed` ids (a gated message stored
while a turn runs is no longer lost; a collected burst carries one history block); typed
`[group] ` speaker lines are neutralised; docs note that `acceptClientMetadata: true` lets clients
forge `metadata.group`.
