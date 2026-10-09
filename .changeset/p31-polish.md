---
"eharness": patch
---

P31 polish.

- **`eharness/subagent`:** `reconcileSubagentWaits(parentSession, { openChild })` resolves parked `agent` waits whose child already finished (crash between the child finishing and its `turn.end` hook); idempotent. New option `subagents({ selfAgent })` runs it, detached and best effort, when a `'park'` parent session opens. New type `SubagentReconcileEntry`.
- **Context accounting:** a stored `media-ref` tool output (filesystem `read_file` of an image or PDF) is estimated like the wire it stands for (text plus 1 500 tokens for an image, per started 50 000 bytes for a PDF) instead of its JSON; the prune stage measures media by a fixed size, so `stats.pruned.chars` is not inflated by base64. No public API change.
- **`fsSkillSource`:** `readFile` returns `{ type: 'binary', mediaType, data }` for binary skill assets when the file system has `readBytes`, instead of throwing.
