---
"eharness": patch
---

Session invariants are enforced and fuzz-tested (spec 05 §15, ADR-0057). Every message the core saves is validated against AI SDK `UIMessage`: with `debug: { invariants: true }` (default when `NODE_ENV` is `test` or `development`) an invalid message is `EH_INVALID_MESSAGE` and nothing is saved; otherwise it is warned (`W_INVALID_MESSAGE`, `details.stage: 'save'`) and saved as it is. On load, a message that holds pending state or the active turn is kept with a warning instead of dropped. New warning `W_INVARIANT_VIOLATION`.

Fixes found by the new fuzz test: a hot loop when a direct send was gated behind a queue held by pending approvals; inbox claims of a restarted process with a stable `recovery.instanceId` were renewed forever (claims now use `<instanceId>#<incarnation>`); a queued or waiting `send()` held by approvals another instance answered never started; an idle handle with unwritten local state stayed blind to another instance's pending state; a `respond()` rejected as stale after another instance patched an older message; an inbox drain whose turn kept failing before its commit point (lock held elsewhere) claimed and released in a loop (now exponential backoff).

`eharness/testing` adds `multiInstanceConformance` (whole storage backend shared by several agent instances) and `assertStoredSessionInvariants`.
