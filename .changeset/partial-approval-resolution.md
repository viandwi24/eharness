---
"eharness": minor
---

Partial resolution of pending approvals. `respond()` with only some of the pending approvals or client tool outputs now records them in the stored pending state (`PendingState.approvals[].answer`, `clientTools[].answer`, compare-and-set, any instance, idempotent per id, a differing re-answer is `EH_INVALID_INPUT` with `details.reason: 'conflict'`) and ends at once with `stop: 'tool-pending'` and `TurnResult.partial: true`. The call that answers the last missing item continues the same message with all answers, as a full `respond()` would; `endTurn` and the other options belong to that completing call. A call that answers nothing is still `'incomplete'`. See spec 11 §4.3 and ADR-0044.
