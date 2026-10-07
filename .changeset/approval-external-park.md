---
"eharness": patch
---

Fix approvals combined with tools that have no `execute` (`externalTool()` and client tools).

- An `approved` status (policy, `approval.risk`, a `tool.approve` hook or a session grant) now means
  "no human needed": the call parks as an external wait or a client call instead of showing up as a
  pending approval that can never be answered meaningfully.
- After a `user-approval` is approved, an `externalTool()` call now parks its wait (the pending state
  is committed, then `start` runs) and `resolveWait()` continues the same message, instead of the
  turn ending `complete` with the call unanswered. Denials are unchanged.
- Approved server calls of the same batch stay pending with `granted: true` (new optional field of
  `PendingState.approvals`) and run after the wait is resolved; `respond()` answers them itself.
