---
"eharness": minor
---

A turn knows who asked for it (ADR-0069). New type `Principal` (the shape of `ApprovalActor`, which is now an alias). `agent.session(id, { principal })` sets the session default (stored in `state.core.principal`; the first value wins), `send` / `respond` / `enqueue` / `inject` / `fork` take `principal`, and `ctx.principal` is set in every hook and tool context (turn, else session, else `undefined`). The principal is durable: it is stored in inbox `send` and `wake` items (`SerializedInput.principal`), in `activeTurn` and in the pending state, so a turn drained, recovered or continued on another instance (including a `respond()` continuation, which keeps the principal of the turn that asked) sees the same value. Inbox adapters must round-trip the new optional fields (`inboxAdapterConformance` checks it).
