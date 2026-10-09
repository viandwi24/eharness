# ADR-0037: Fork keeps ids; the child index is a foreign-writable field of the parent's state

Status: **Accepted** · Date: 2026-10-09 · Builds on: [ADR-0021](0021-cross-process-abort.md), [ADR-0034](0034-deployment-profiles.md)

## Context

Two harness needs surfaced in the coder benchmark: branching or rewinding a conversation
(`session.fork`) and listing the child sessions of a parent turn (subagents). The example did both
with application code (copy messages and state; keep the parent link in memory). ADR-0034 asks
that every feature works for an autonomous server, a single-process CLI and a split web/server
with several instances and restarts: no in-memory-only index.

## Decision

- **Fork keeps message ids.** A fork copies a strict prefix of the history with the
  `MessageAdapter` (`load({ beforeId, limit })` pages, `save`), unchanged. Ids stay time-sortable
  and unique per session (storage is keyed by session id), and references inside the history
  (`parentId`, rewind / compaction markers) stay valid. Regenerating ids would need a rewrite of
  every reference and gives nothing. State is copied selectively: usage, grants, plugin state, and
  the compaction / rewind pointers recomputed from the copied messages; never `activeTurn`,
  `pending`, `abortRequest`, inbox bookkeeping, `parent` or `children`. The lineage is
  `core.forkedFrom`. A fork refuses while a turn runs and when the copy would include a pending or
  unfinished message.
- **The child index lives in state.** A child records `core.parent` in its own state and appends
  to `core.children` of the parent's state (capped at 500). `children()` / `parentInfo()` read
  stored state, so they work in every instance and after restarts.
- **`core.children` is foreign-writable**, the second field after `abortRequest` (ADR-0021): the
  child writes the parent's state through its own `StateAdapter` (it may belong to an agent in
  another process) with read, append, `setIf(rev)` and retry. The owner of the parent never writes
  the list; on a conflicting write it takes over the stored list and `rev`. The commit-point
  compare-and-set treats a conflict that only added children as no conflict.

## Consequences

- No adapter contract change: `MessageAdapter` and `StateAdapter` conformance suites are unchanged.
- Without `setIf` the registration is a plain read-modify-write and a race may lose an entry
  (the child's own `core.parent` stays correct). A parent without stored state is not created.
- A failing fork leaves orphaned messages under the new id; a retry needs another id.
- Every owner write with `setIf` is now a compare-and-set that merges `children` on conflict
  (before: only writes during a turn).
