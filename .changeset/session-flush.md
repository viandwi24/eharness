---
"eharness": minor
---

`session.flush()` (spec 06 §5.2a rule 11): runs only the pre-compaction flush over the model-visible history (everything after the last compaction marker), with the same `compaction.before` hooks and flush patch as a manual compaction, then stops. No summarizer call, no marker, no change to stored messages besides the `eh.flush` record. It has the same guards as `compact()` (idle only, `EH_SESSION_BUSY` during a turn) and resolves `{ status: 'flushed' }`, `{ status: 'skipped', reason }` or `{ status: 'failed', reason: 'flush', error }` instead of throwing for a flush that failed. The `compaction.before` event gets an optional `flushOnly: true` field for this call; it is absent for every existing compaction, so existing hooks are unaffected. `onFailure` of a patch does not apply to `flush()`. Without the new method nothing changes.
