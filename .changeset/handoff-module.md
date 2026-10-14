---
"eharness": minor
---

New module `eharness/handoff` (Draft): an agent hands a question or decision to a person and the turn parks on an external wait. `handoff({ store, notify })` registers the `ask_person` tool; `resolveHandoff`, `cancelHandoff` and `expireHandoffs` answer, cancel or expire a request from any instance and resume the same assistant message. Async `HandoffStore` port with compare-and-set answers, `memoryHandoffStore`, and the conformance suite `handoffStoreConformance` in `src/testing/handoff.conformance.ts`.
