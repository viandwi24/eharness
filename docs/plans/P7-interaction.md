# P7 — Interaction: approvals, respond, regenerate/edit, steer, queue, wake

Status: in progress · Branch: `phase/P7-interaction`

## Goal

Everything a user or UI does to a session besides sending a new message, on top of the P2 runtime:
human-in-the-loop tool approval, client-side tools, regenerate/edit with rewinds, steering and
queueing while a turn runs, background wake-ups, and the `useChat` adapter `handleChatRequest`.

## Specs

- 11 (all)
- 05 §2, §3 (operation checks, commit point), §7 (`pending`, `grants`, `rewinds`)
- 04 §2 (continuation turns), §6 (attach caveat)
- 03 §5 (`eh.rewind`), §6 (`data-eh.input` split, `deliveredIn`)
- ADR-0011, ADR-0012

## Owns

`src/session/interaction/**`, `src/stream/chat-request.ts`. Small, separate commits in
`src/session/**` and `src/loop/**` for the hooks P2 left (operation checks, step-boundary
delivery queue).

## Checklist

1. [x] Pending state: detection at step end (spec 11 §2), `state.core.pending`,
   `metadata.eharness.pending`, `stats().pending`, `pending` session event.
2. [x] Approval function per step: policy + `tool.approve` hooks + grants, most restrictive wins,
   fail closed, `approval.secret` → `experimental_toolApprovalSecret`.
3. [x] `respond()`: state re-read, validation (`unknown-id`, `incomplete`, `stale`), atomic
   consume before any execution (commit-point write with `setIf` when available), part patching
   by **merging** approval objects, `pending: null`, grants effective after step 0, continuation
   into the same message (`originalMessages`, `start` without metadata), step 0 wire ending with
   the approval `tool` message (no reminder, no `data-eh.input`), client tool outputs through
   `tool.after` + limits.
4. [x] `onNewInput` (`deny` patching / `reject` → `EH_PENDING_RESPONSE`) for send/regenerate/edit.
5. [x] `eh.rewind`, view rule in loader and `messages({ includeHidden })`, `state.core.rewinds`
   mirror + healing, `regenerate()`, `edit()` with `clientId` carry-over, `'not-found'` and
   `'beyond-compaction'` errors.
6. [x] `ifBusy`: `steer` (normalize + `input.submit` immediately, delivery at the next boundary,
   forced continuation, fallback to queue), `queue` (in-memory FIFO, runs after the current turn,
   dropped on abort/close), `reject`.
7. [x] `inject()` options: `deliver: 'next-step'` (`data-eh.input { source: 'event' }` +
   `deliveredIn`), `wake` (idle → no-input turn; running → next-step).
8. [x] `handleChatRequest` dispatch (spec 11 §7) with `extractResponses` reading only decision
   fields.
9. [x] Integration tests: scenarios 17–26 of testing.md; round-trip reload after each operation.

## Acceptance criteria

- [x] A `useChat` client (driven by `@ai-sdk/react` test utilities or recorded request bodies)
      completes: submit → approval → approve → answer; regenerate; edit; steer during a tool loop.
- [x] No test can make a tool execute twice or execute after a stale/replayed answer.
- [x] Reloading after every operation reproduces the same model wire as the hot session.

## Open questions

Decided conservatively (specs updated where the answer is normative):

1. **Steer edge cases.** Invalid steer input → a separate failed run (`EH_INVALID_INPUT`); a steer
   that arrives after the running turn stopped taking input, a steer without input, or a steer
   while `compact()` runs → a queued `send` turn (`via: 'queue'`). Undelivered steers converted to
   queued turns (non-pending/abort stops) are appended to the FIFO and do **not** run
   `input.submit` again (they already passed it with `via: 'steer'`); the steer's `SendOptions`
   are not carried over. Spec 11 §6.1.
2. **`wake` while pending** starts no turn (a background event must never auto-deny approvals);
   an undelivered `next-step` injection stays for the next turn and never starts one; kinds without
   a model projection are not delivered inline; projection file parts are not delivered inline.
   Spec 11 §6.3.
3. **`edit()` client id.** The new user message gets `U.clientId ?? U.id`, so editing the same id
   again targets the replacement (useChat keeps the id). Spec 11 §5.
4. **Grants at step 0.** Only the grants recorded by the current `respond()` wait for step 1;
   grants recorded earlier apply at step 0 too. A `never` grant denies without a reason text.
   Spec 11 §3.1.
5. **`tool.before` requirement.** AI SDK 7.0.122 stores `inputSchemaInput` (the pre-refinement
   input) whenever the refinement changed the input and re-validates from it, so a refining hook
   runs once and must be *deterministic*; idempotency only matters for history without
   `inputSchemaInput`. Spec 11 §3, ADR-0012, spec 01 TSDoc and testing.md scenario 17 updated.
6. **A continued message is "running".** A' is saved without `metadata.eharness.stop`, so a crash
   during the continuation is recovered (`INTERRUPTED_CRASH`, `stop: 'interrupted'`) instead of the
   loader healing `activeTurn` away. Spec 11 §4.
7. **Run error details.** `TurnResult.error.details` carries `details` of `EH_*` errors (e.g.
   `{ reason: 'stale' }`), so apps can tell respond/regenerate/edit rejections apart; the stored /
   streamed `metadata.eharness.error` keeps `{ code, message }`. Spec 10 §4.
8. **`respond()` state re-read** is skipped when the in-memory state is dirty (unwritten plugin
   state would otherwise be lost); the commit-point `setIf` still detects a foreign consumption.
9. **Stream start.** The `createUIMessageStream` is created when `start` is written (a
   continuation needs A' as `originalMessages`); transient chunks of the preparation (warnings) now
   follow `start` instead of preceding it. Spec 04 §2.
10. **P3 handoff (`delivered` for respond).** Not needed: A' (with its `approval-responded` parts)
    is saved and cached before the wire is built, so `build()` projects the trailing approval
    `tool` message itself (`continuing: A.id`); `delivered` keeps its meaning (step-boundary input).

## Requests to other phases

Handled in P7 (outside `src/session/interaction/**`): `buildApproval()` grants + fail-closed
policy (P2 review request), `finishToolOutput()` for client outputs (P6 request), the
step-boundary inbox and continuation rules in `runSteps()`, the loader's `state.core.rewinds`
healing, and a fix in `sanitizeModelMessages()` (`src/messages/sanitize.ts`): an automatic
approval's result was dropped as a duplicate of its trailing approval response, so AI SDK executed
automatically approved tools twice (pre-existing since P2).

- To P8: `examples/next-route.ts` can use `handleChatRequest(session, body, { ifBusy: 'steer' })`
  for steering from a second request; a resumed continuation (`attach()` after `respond()`)
  replays only the continuation (spec 11 §7 caveat) — the guide should re-fetch
  `session.messages()` at `turn-end`. `EH_NOT_IMPLEMENTED` is gone (repo-wide grep only finds plan
  history). `run.result.error.details.reason` distinguishes respond/regenerate/edit rejections.
- To P8 (docs): the approvals guide should mention that `tool.before` must be deterministic and
  approval policies/hooks side-effect free (spec 11 §3), and that exactly-once approvals across
  instances need a `SessionLock` or a `setIf` state adapter.

- From P2: stubs to replace — `respond()`, `regenerate()`, `edit()` return a failed run with
  `EH_NOT_IMPLEMENTED` (`failedRun()` in `src/session/session.ts`); `send(…, { ifBusy: 'queue' |
  'steer' })` throws `EH_SESSION_BUSY` while a turn runs; `inject()` rejects `deliver: 'next-step'`
  and `wake` with `EH_NOT_IMPLEMENTED`. Pending: a `tool-pending` stop writes
  `state.core.pending`, `metadata.eharness.pending` and a `pending` event (`onEnd` in
  `src/session/turn.ts`); the next `send()` just clears `state.core.pending` at the commit point
  and projects with `pending: null` (open calls reach the model as `INTERRUPTED_UNKNOWN`) —
  replace with `approval.onNewInput`. The approval function (`buildApproval()` in
  `src/registry/wrap.ts`) has no grants yet; `approval.secret` is already passed as
  `experimental_toolApprovalSecret`. Step-boundary delivery is the `waiting` queue in `runSteps()`
  (`src/loop/steps.ts`), currently fed by `step.end` context and `turn.beforeEnd`; steers and
  `next-step` injections go there (and not before step 0 of a `respond` turn). The loader applies
  the rewind view rule (`hiddenByRewind()` / `rewindsIn()` in `src/session/load-context.ts`) but
  does not heal `state.core.rewinds`; `messages()` filters with page rewinds + the state mirror.
  When the last stub is gone, `EH_NOT_IMPLEMENTED` can leave the error union (see P8).
- From P2 (review): `buildApproval()` (`src/registry/wrap.ts`) lets a throwing `approval.policy`
  (per-tool function or generic function) propagate, while throwing `tool.approve` hooks count as
  `denied`. Spec 11 §3 is fail-closed: catch policy errors too and treat them as `denied` (with the
  error message as reason), and add a test.
- From P3: compaction is wired for `send()` only. `src/session/turn.ts` builds the turn wire with
  `createTurnCompaction()` (`src/compaction/turn-context.ts`) and `currentTurnStartId()`
  (`src/compaction/turns.ts`), which already implements the current-turn rules of spec 06 §5.1 for
  `{ kind: 'respond', messageId }`, `{ kind: 'regenerate', assistantId }` and `edit` (= `'input'`).
  For `respond()` pass `pending` / `continuing` to `createTurnCompaction()` (used for projection)
  and pass the continuation's extra wire (the `tool` message with the approval responses, which is
  not in the cached view) as `delivered` to `build()` — the loop re-appends
  `wire.slice(sinceBarrier)` after a mid-turn rebuild, so it must also be counted there. Manual
  `compact()` already keeps the pending message's turn (`currentTurnStartId(…, { kind: 'respond' })`).
  Rewind × compaction: the loader and `rt.view` exclude hidden messages before compaction sees them;
  `'beyond-compaction'` must compare `afterId` with the newest boundary's `resumeFromId`
  (`payloadOf()` in `src/compaction/turns.ts`).
- From P6: client tool outputs (`respond({ toolOutputs })`, spec 09 §6) must pass through
  `tool.after` and the output limits like server outputs. The limit helper is
  `limitToolOutput(toolName, toolCallId, output, { config: rt.agent.config.toolOutput,
  toolOutputs: open.services.get('toolOutputs'), warn: rt.warn })` in
  `src/registry/output-limits.ts` (strings → head + tail, structured →
  `{ truncated, preview, originalChars }`, `evict` via the `toolOutputs` service,
  `W_TOOL_OUTPUT_LIMITED`); run the `tool.after` chain first (see `finish` in `wrapTool()`,
  `src/registry/wrap.ts`).
