# ADR-0014: Interrupted tool calls are answered, not dropped

Status: **Accepted** · Date: 2026-09-29

## Context

Aborts, timeouts, provider errors, invalid tool context and dead processes leave tool calls without
results. Providers reject a tool call without a matching result. The common fixes are to drop the
dangling call (`ignoreIncompleteToolCalls`) or to delete the message. Both hide from the model that
it started an action — it may repeat a non-idempotent operation or lose track of state.

## Decision

A tool call without a result is **answered** with an error result (fixed texts
`INTERRUPTED_TURN`, `INTERRUPTED_CRASH`, `INTERRUPTED_UNKNOWN`, spec 10 §5):

- at the end of every turn that does not stop with `tool-pending` (stored parts patched to
  `output-error`);
- by crash recovery on the next operation (`stop: 'interrupted'`, `eh.notice EH_TURN_INTERRUPTED`);
- by projection and the guard for anything else (older data, external writers).

Tool calls legitimately waiting (`tool-pending`) are never touched. Interrupted tools are never
re-executed automatically.

## Consequences

+ The model always knows which actions did not complete; wires are always valid.
+ UIs show the interruption on the tool part itself.
− The model may retry the tool itself; tools with side effects should be idempotent or check state.

## Alternatives considered

- Drop dangling calls (rejected: silent loss of information).
- Re-run interrupted tools on recovery (rejected: unsafe for side effects).
