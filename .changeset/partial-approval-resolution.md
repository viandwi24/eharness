---
"eharness": minor
---

**BREAKING:** Partial resolution of pending approvals. `respond()` with only some of the pending approvals or client tool outputs now records them in the stored pending state (`PendingState.approvals[].answer`, `clientTools[].answer`, compare-and-set, any instance, idempotent per id, a differing re-answer is `EH_INVALID_INPUT` with `details.reason: 'conflict'`) and ends at once with `stop: 'tool-pending'` and `TurnResult.partial: true`. The call that answers the last missing item continues the same message with all answers, as a full `respond()` would; `endTurn` and the other options belong to that completing call. A call that answers nothing is still `'incomplete'`. See spec 11 §4.3 and ADR-0044.

Migration: before, `respond()` with only some of the pending ids rejected with `EH_INVALID_INPUT` (`details.reason: 'incomplete'`). It now succeeds with `stop: 'tool-pending'` and `partial: true`. Code that relied on the rejection (to force a client to answer everything) must check `TurnResult.partial` or compare the answered ids with the pending ones itself.
