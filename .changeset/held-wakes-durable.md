---
"eharness": patch
---

A `wake` injection (`inject(…, { wake: true })`, background subagent reports) that arrives while approvals, client tool calls or external waits are pending is now held in the durable inbox when `storage.inbox` exists: it survives a restart and runs once in whichever instance resolves the pending items, instead of living only in the in-memory queue of the instance that received it (lost wake). `inject()` also reads the stored state, not the instance's cache, to decide whether the session can wake now. See spec 11 §6.3 and ADR-0054.

Several undelivered `wake` injections now run as one wake turn (also in the in-memory queue), not one no-input turn per report.
