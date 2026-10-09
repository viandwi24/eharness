# ADR-0035: Nested approvals: park the parent at the tool boundary

Status: **Accepted** · Date: 2026-10-09 · Builds on: [ADR-0012](0012-approvals-server-owned-pending.md), [ADR-0027](0027-external-waits-park-at-the-tool-boundary.md), [ADR-0034](0034-deployment-profiles.md)

## Context

A subagent tool runs a child session. When the child needs an approval, the parent's tool call
today awaits it in memory. That is fine for a single-process interactive product, and it breaks a
split web/server product: the server restarts, several instances run, and the answer may arrive
hours later on a different instance.

Prior art, described generically: a client-server coding agent keeps pending permissions as
in-memory deferred promises in the server process and links child sessions to their parent by id.
A terminal coding agent keeps its process alive (a supervisor for background sessions) and offers
a "defer" hook that exits the process and later resumes one deferred tool call; that is limited to
a single tool call per turn and to non-interactive use. Neither persists nested approvals.
References: https://opencode.ai/docs/ and https://code.claude.com/docs/en/hooks.

## Decision

The `eharness/subagent` tool supports three approval strategies for the child session:

- **`'inline'`.** The tool awaits a caller-supplied answerer in process and continues the child
  with `respond()`. Profile (b) of ADR-0034. Nothing is durable beyond the child's own pending
  state.
- **`'park'`.** When the child's turn stops `tool-pending`, the parent's tool call **parks as an
  external wait** (ADR-0027). The wait payload names the child session and the pending items
  (approval ids, tool names, inputs). The child's approvals are answered with `respond()` on the
  **child** session, from any instance. When the child's turn completes (in any instance), the
  subagent plugin's `turn.end` hook on the child resolves the parent's wait with the child's final
  report through `resolveWait()`, and the parent continues. Several children and batches work
  because external waits support batches.
- **`'deny'` / policy.** Profile (a): there is no human. Child approvals are resolved by policy
  (bypass or deny); the child never parks.

A parent/child index lets UIs find pending child approvals: `session.children()` on the parent and
a `parent` link on the child.

### Failure rules

- Child turn error or abort: the wait resolves with an error string (tools return errors as
  strings; the parent model can read and react).
- Parent abort: the child receives an abort request (cross-process abort, ADR-0021).
- Timeouts use the wait's own timeout (ADR-0027: timer, inbox timer, `expireWaits()`); the
  `onTimeout` result is an error string.
- The first resolution wins (compare-and-set), so a late child report after a timeout is
  `already-resolved` and is ignored.

## Alternatives considered

- **Propagating the child's pending state into the parent's pending state.** Rejected: two sources
  of truth for one approval, and `respond()` on the parent would have to route into the child
  (consume-once, ADR-0012, would need to hold across two sessions).
- **Replaying the child inside the parent turn** after an answer. Rejected: it re-executes work
  (violates ADR-0014: a call is answered, never re-executed) and holds the parent turn open.

## Consequences

- The parent is not held in memory while a child waits for a person; restarts and scale-out work.
- The UI answers child approvals against the child session id taken from the wait payload or
  `session.children()`; the parent only receives the final report.
- The subagent plugin must be installed on the instance that completes the child turn so its
  `turn.end` hook runs; applications register the same plugin set on all instances (already
  required for external waits).
- `'inline'` stays available and is the simplest choice for a CLI.
- Needs a storage adapter with `setIf` or a lock, as for any external wait.
