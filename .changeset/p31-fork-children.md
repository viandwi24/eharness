---
"eharness": minor
---

Session families (P31 L3, R10).

- **`session.fork(options?)`** creates a new session from a prefix of the history (`beforeMessageId`, default all; `id`, `runtime`, `copyState: 'all' | 'none'`) and returns its opened handle. Message ids are kept; usage, grants, plugin state and the compaction / rewind pointers are copied (never the active turn, pending approvals, abort requests or inbox bookkeeping); the lineage is stored as `core.forkedFrom`. Refused with `EH_SESSION_BUSY` while a turn runs and `EH_INVALID_INPUT` when the copy would include a pending or unfinished message or the id exists. New types `ForkOptions`.
- **`session.children()` / `session.parentInfo()`** and the durable parent/child index: a session opened with `SessionOptions.parent` records `core.parent` and registers in the parent's `core.children` (append-only, capped at 500, a compare-and-set write through the state adapter, also across agents sharing the storage). New types `ChildSessionInfo`, `ParentInfo`; `SessionStateSnapshot.core` gains `parent`, `children`, `forkedFrom`.
- **Behaviour change:** state writes of an owner with a `setIf` adapter are now compare-and-sets that take over `core.children` on conflict (before only writes during a turn were); the commit-point write no longer fails with `EH_SESSION_BUSY` when only a child registered meanwhile.
