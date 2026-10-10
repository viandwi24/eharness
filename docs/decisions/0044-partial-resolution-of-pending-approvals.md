# ADR-0044: Partial resolution of pending approvals

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0012](0012-approvals-server-owned-pending.md) (see spec 11 §4)

## Context

One step can raise several approval requests in parallel. A UI or server that answers them one at
a time (`respond({ approvals: [one] })`) was rejected with `EH_INVALID_INPUT` (`'incomplete'`):
spec 11 v0 required every pending item in one call. A real-model run of the team example got
stuck this way: every single answer failed and the turn stayed `tool-pending`.

## Decision

- `respond()` with a subset records the answers in the stored pending state
  (`approvals[].answer`, `clientTools[].answer`) with a compare-and-set on the state rev, from
  any instance. The run ends at once: `stop: 'tool-pending'`, `partial: true`, `pending` with the
  `answer` markers. No message is saved, nothing runs, no model call.
- The call that completes the set (this call's answers plus the recorded ones) is a normal
  continuation into the same message with all answers. Consumption stays atomic (ADR-0012): the
  recorded answers are authorizations only for that one continuation, never executed before it.
- Recording is idempotent per id; a different re-answer is `EH_INVALID_INPUT` (`'conflict'`).
  A call that answers nothing is still `'incomplete'`. External waits are not recorded
  partially (they have `resolveWait()`).
- `endTurn` and other options belong to the completing call; recorded answers carry `reason`,
  `remember`, `actor` and `note`. With several `endTurn` sources there is no conflict by design:
  only the completing call's `endTurn` counts.

## Alternatives

- A new `recordAnswer()` API: a second way to do the same; `respond()` already validates.
- Persisting `endTurn` per answer: ordering questions with no real use case.
- Updating the stored message per partial answer: extra writes and a second authority; the
  pending state is the authority and a UI renders from it.

## Consequences
Minor, additive: new optional `PendingState` fields and `TurnResult.partial`. A client that
relied on the `'incomplete'` rejection for a subset now gets a recorded partial answer.
