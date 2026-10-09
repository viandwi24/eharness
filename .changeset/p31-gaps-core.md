---
"eharness": minor
---

Core and library gaps found by migrating the coder example (P31).

- **`session.onRun(listener)`** is called synchronously whenever any turn of the session starts in this process: `send`, `respond`, `regenerate`, `edit`, queued turns, the turn a steer falls back to, wakes from `inject` (including `ctx.session.inject` and background deliveries) and inbox drains. Every listener gets its own `HarnessRun` (a reader of the turn buffer, like `attach()`), so streaming it never takes the stream from the caller or other listeners. In-process only; use `events()` + `attach()` across instances.
- **`session.fork` hook** (`{ sourceSessionId, targetSessionId, beforeMessageId?, keptMessageIds }`) runs after `session.fork()` copied the history; a throwing hook is `W_HOOK_FAILED` and the fork still succeeds. The filesystem plugin uses it to copy the file checkpoints of the kept turns into the new session. `CheckpointStore` gains an optional `copy()`; new `copyCheckpoints()`.
- **Checkpoints of child sessions:** `checkpointsSince` / `rewindFiles` take `sessionIds` (typically `session.children()`); snapshots of all sessions are ordered together by their UUIDv7 turn keys. `FileCheckpoint` gains `sessionId`.
- **`eharness/subagent`:** the `subagentTasks` service (`list`, `get`, `stop`, `stopAll`, `subscribe`; entries `{ id, agent, description, childSessionId, status, startedAt, endedAt?, tail }`), a `data-subagent.run` part for background children, and `backgroundInChildren` (default `false`): `run_in_background` is now offered only in sessions without a parent, because a child session's background work is aborted when the child closes and its report would not reach the root session.
