---
"eharness": minor
---

External waits: park a turn on a result that arrives later, in any instance (spec 11 §4.2, ADR-0027).

- New `externalTool({ description, inputSchema, outputSchema?, start?, timeoutMs?, onTimeout?, metadata? })`:
  an AI SDK tool without `execute` whose result comes from outside (a webhook, a job, another
  agent, a person). `start` runs once per call after the step ended and before the pending state is
  committed (stable `waitId` = `w_<toolCallId>`; a throwing `start` answers the call with an error
  result). The turn stops `'tool-pending'` and holds nothing.
- New `session.resolveWait(waitId, { output } | { errorText })`: validates against `outputSchema`
  (`EH_INVALID_INPUT`, `details.reason: 'invalid-result'`), applies `tool.after` and the output
  limits, and records the result with a compare-and-set; the first result wins, a replay is
  `already-resolved`. When nothing is left open the **same** assistant message continues like a
  `respond()` continuation. New `session.expireWaits(now?)` (sweepers) and `session.pendingWaits()`;
  `respond({ externals })` answers waits together with approvals and client tool calls.
- Timeouts: `timeoutMs` / `timeoutAt` with an explicit `onTimeout` result (default
  `WAIT_TIMED_OUT`), applied by a timer in the holding process, by a durable `wait-timeout` inbox
  item (`availableAt`, any instance) or by `expireWaits()`; all go through the same
  compare-and-set. New input with `onNewInput: 'deny'` answers open waits with
  `WAIT_CANCELLED_NEW_INPUT` (results already recorded are kept).
- Clients cannot resolve external waits: `handleChatRequest` ignores such answers and
  `respond({ toolOutputs })` for an external call is `EH_INVALID_INPUT` (`'wrong-kind'`).
- **New pending kind / type-level changes:** `PendingState` gains `v` (`2`, written by 0.5; no `v`
  is the 0.3 / 0.4 shape, an unknown `v` authorizes nothing), the optional `externals` array
  (`PendingExternal`) and optional `timeoutAt` / `onTimeout` on `clientTools[]`. `InboxItemInput`
  gains the kind `wait-timeout` and `SessionEvent` gains `wait-resolved` (exhaustive switches must
  add them; the `inbox-enqueued` / `inbox-dead` events can carry the new kind).
  `EH_INVALID_INPUT` `details.reason` gains `'wrong-kind'` and `'invalid-result'`. New exports:
  `externalTool`, `ExternalToolDef`, `WaitStart`, `WaitStartEvent`, `ResolveWaitResult`,
  `PendingExternal`, `WaitResult`, `WaitTimeoutResult`, `WAIT_TIMED_OUT`,
  `WAIT_CANCELLED_NEW_INPUT`. `HarnessSession` gains three methods (custom implementations of the
  interface must add them).
- Stored pending state is now written with `v: 2`; sessions that never use `externalTool` are
  otherwise unchanged.
