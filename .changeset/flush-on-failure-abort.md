---
"eharness": minor
---

Add `flush.onFailure: 'continue' | 'abort'` to the `compaction.before` patch (spec 06 §5.2a rule 9a). The default `'continue'` keeps today's behaviour. With `'abort'`, a pre-compaction flush that failed or was skipped does not summarize: no marker, the stored history stays complete, a failed flush still saves its `eh.flush` record with the error. Automatic compactions warn `W_COMPACTION_FAILED` with `details.reason: 'flush'` and the guard keeps the request in the window; a manual `compact()` rejects `EH_COMPACTION_FAILED` with the same `details.reason`. Overflow recovery ignores the policy.
