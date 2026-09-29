# P2 — Session, loop, streaming, storage contracts

Status: done · Branch: `phase/P2-runtime`

## Goal

A working agent: `agent.session(id).send(text)` runs a multi-step turn with tools, streams AI SDK
UI message chunks, persists messages per step through `MessageAdapter`, keeps state through
`StateAdapter`, supports abort, attach, inject, hooks and namespaced data part writers. No
compaction yet: the guard implements sanitize and the final overflow stop (`EH_CONTEXT_OVERFLOW`);
turn dropping/truncation and `stats()` details come in P3 (`stats()` returns plain estimates here).

## Specs

- 01 §2 (session phase), §4, §5, §6
- 02 §2 (assembly), §3.1, §5–§7
- 04 (all)
- 05 (all except §5 pointer path — implement the paging fallback now; pointer comes in P3 — and
  the interaction operations of §2 `respond`/`regenerate`/`edit`/`ifBusy`, which are P7)
- 10 (all)

## Owns

`src/session/**`, `src/loop/**`, `src/stream/**`, `src/storage/**`, `src/registry/**` (taken over
from P1; the dynamic tool-source parts of `src/registry/tools.ts` go to P6),
`src/testing/message-adapter.conformance.ts`, `src/testing/state-adapter.conformance.ts`,
`src/testing/scripted-model.ts`, `src/agent/**` (runtime parts), `scripts/smoke.mjs` (extend).

## Checklist

1. [x] Contracts: `MessageAdapter`, `StateAdapter` (incl. optional `setIf`, `rev`), `SessionLock`,
   `SessionStateSnapshot`, `PluginState` (namespaced, dirty tracking).
2. [x] `storage/memory.ts`: `memoryMessages()`, `memoryState()` (deep copies on read/write).
3. [x] `testing/`: `messageAdapterConformance`, `stateAdapterConformance`, `scriptedModel` (wraps
   `MockLanguageModelV4`, records prompts), run both suites against memory adapters.
4. [x] Session cache in the agent (`session()`, `closeSession()`, `close()`, idle eviction).
5. [x] Session open: state load, plugin `session()` phases in order, services wiring, `ToolInput`
   function resolution, `session.start` hooks, dispose on close.
6. [x] `HarnessContext` implementation with live getters (turn, step, stream).
7. [x] Turn lifecycle exactly as spec 05 §3 (sync busy flag, everything else inside `execute`,
   lock, `lastId` validation before writes, preparation vs commit point, input normalization,
   `input.submit` (rewrite/block/context, fail closed), `turn.prepare`, `SendOptions` overrides
   (`model`, `settings`, `options` validated by `callOptions`, `maxSteps`, `toolsContext`
   validation), failure semantics: only `EH_SESSION_BUSY`/`EH_SESSION_CLOSED` throw) +
   `session.ready()`.
7a. [x] Stop rules of spec 05 §3.1 incl. `turn.beforeEnd` (`continue`, `extendSteps`,
   `maxContinues`), `turnTimeoutMs` → `'timeout'`, AI SDK step timeouts → `'timeout'`,
   `'blocked'`; dangling tool calls answered at the end of aborted/timed-out/failed turns.
7b. [x] Crash recovery (spec 05 §9): `state.core.activeTurn` at the commit point, heartbeat,
   stale detection (lock or `staleMs`), recovery patch + `eh.notice`, `recovery: false`.
7c. [x] Step-boundary delivery of `data-eh.input` (used by `step.end` `context`, `turn.beforeEnd`
   and — in P7 — steers and `next-step` injections).
8. [x] Loop: one `streamText` per step with `instructions` (not `system`), `stopWhen:
   isStepCount(1)`, wire accumulation from guarded `await result.responseMessages`, `step.prepare`
   (model, settings, activeTools, toolChoice, reminder, providerOptions, messages) / `step.end`
   hooks, settings pass-through (`timeout` without `totalMs`, `streamRetries` with `reset-step`,
   `repairToolCall`), telemetry pass-through, `ctx.turn.addUsage`. Call `registry.toolsForStep(discovered)` every step and collect
   discovered names from `tool_search` results (spec 02 §3.3) — P6 adds deferral itself.
9. [x] Tool wrapping: `tool.before` via `experimental_refineToolInput`; execute wrapper with
   `tool.after`, preliminary (AsyncIterable) pass-through, `HarnessToolError`, status part;
   approval function plumbing (`toolApproval` built from policy + `tool.approve`; the pending /
   respond flow itself is P7). No `needsApproval` in eharness code.
10. [x] Stream exactly as spec 04 §2: `start` with metadata, per-step `for await … writer.write`
    (no `merge`), `onError` on **both** `createUIMessageStream` (`describeError`) and
    `toUIMessageStream` (`uiErrorText`: `String(e)` for `HarnessToolError`), step `abort` chunks
    dropped, `setOutcome`, `message-metadata` + `finish` | `abort`; chunk cloning for the turn
    buffer and `run.stream`.
11. [x] Persistence via `createUIMessageStream({ onStepEnd, onEnd })` → `message.beforeSave` →
    `save`; per-step barrier resolved by `onStepEnd`; end sequence in `onEnd` with the
    `committed` flag (spec 05 §3 steps 15–17); the core drains the stream and `run.stream`
    replays the turn buffer (instead of a tee branch, open question 1; spec 04 §5 updated);
    transient parts excluded; fixed texts module (spec 10 §5).
12. [x] `PluginStreamWriter` (namespacing, transient defaults, outside-turn behaviour, warnings).
13. [x] Turn buffer + `attach()`; `events()` channel; `inject()`; `abort()`; `messages()`;
    `HarnessRun.toResponse()` / `pipeTo()`.
14. [x] Context load (paging fallback, validation policy, boundary ordering) + hot cache +
    `lastId` check.
15. [x] Prompt layout and caching (spec 02 §5–§6): two system blocks, turn/step reminders (never
    stored), `toolOrder`, `cache` modes gated to Anthropic models, `W_CACHE_BUST`, usage cache
    fields in metadata.
16. [x] Integration tests: scenarios 1–4, 7 (sanitize part), 10–15, 27–31, 33, 35, 36 of testing.md.
17. [x] `scripts/smoke.mjs`: run one scripted two-step turn under Node (runs the
    `messageAdapterConformance` suite against `memoryMessages()` too). Verified locally under Bun
    with the packed tarball (with and without `@ai-sdk/mcp`); Node itself runs in CI.

## Acceptance criteria

- [x] A turn with 2 steps (tool call → answer) saves the assistant message 3 times (after step 0,
      after step 1, final with metadata) with the same id and ends with correct
      `metadata.eharness` (usage, stop, steps, durationMs). (`src/session/turn.int.test.ts`)
- [x] Golden test of the exact chunk sequence of that turn passes 100 times in a row (no
      interleaving flakiness). (`__golden__/two-step-turn.chunks.json`, looped in the test; the
      whole suite was also run 25× sequentially and 24× under 4-way parallel load without a failure)
- [x] Reloading with a new agent instance and the same memory adapters reproduces the same model
      wire for the next turn (round-trip test).
- [x] `run.result` never rejects for model/tool errors; `EH_SESSION_BUSY` on concurrent send.
- [ ] Node smoke test passes in CI for 22 and 24. (No Node locally; the same script passes under
      Bun against the packed tarball. To be confirmed by CI on the PR.)

## Open questions

Resolved conservatively in P2 (specs updated where the behaviour is normative):

1. **`run.stream` is a turn-buffer reader, not a `tee()` branch** (spec 04 §5 updated). A tee
   branch shares — and buffers — the chunk objects AI SDK mutates while reconciling data parts, so
   a slow caller could see later states. The core drains the `createUIMessageStream` output itself
   and clones every chunk at write time; `run.stream` and `attach()` both replay the buffer.
2. **`EH_NOT_IMPLEMENTED` stays in the error union** (spec 10 §1: development only). It is no longer
   thrown by `agent.session()`; it is now used only by the stubs of later phases: `respond()`,
   `regenerate()`, `edit()` (run errors), `inject()` with `deliver: 'next-step'` / `wake` and
   `compact()` (rejections). P3/P7 remove the stubs; P8 checks that nothing uses the code before
   0.1.0 and then removes it from the union.
3. **`ifBusy: 'queue' | 'steer'`** behave like `'reject'` while a turn runs (P7 implements them); on
   an idle session they are a normal `send()`.
4. **New input while pending (P2 only):** a turn that stops `tool-pending` writes
   `state.core.pending` and `metadata.eharness.pending`; the next `send()` clears
   `state.core.pending` at the commit point and projects with `pending: null`, so the open calls
   reach the model as `INTERRUPTED_UNKNOWN`. P7 replaces this with `approval.onNewInput`.
5. **Blocked turns** (`input.submit` block with `persist`) create no assistant message: `start`
   carries a throwaway id, `TurnResult.messageId` is undefined, `turn-end` names the notice id
   (spec 05 §3 step 8 updated).
6. **`turn-end` / `turn.end` only for committed turns** (symmetric with `turn-start` /
   `turn.start`); early failures emit `status` events only (spec 05 §3 step 17 updated).
7. **Hook order:** plugin order, and within one plugin setup hooks before session hooks (spec 01 §5
   clarified). `turn.prepare` `activeTools` of several hooks are intersected, like `step.prepare`.
8. **`step.prepare` `messages` rewrites** replace the step wire before reminders are inserted, so
   rewrites never lose the turn/step reminders; reminder format
   `<system-reminder>\n…\n</system-reminder>` (spec 02 §5 updated).
9. **Instruction functions that throw** fail the turn before the commit point (never silently
   dropped; spec 02 §2 updated).
10. **Forced continuations:** `continue` and `extendSteps` both count toward `loop.maxContinues`;
    `step.end` `context` still waiting when the turn stops with anything but `'complete'` is
    discarded (spec 05 §3.1 updated).
11. **Preliminary tool results + `tool.after`:** every yielded value streams as preliminary; if
    `tool.after` changes the last value it is yielded once more as the final output (spec 01 §5
    updated).
12. **Custom `generateId` below the floor** is reported with `ctx.log.warn` once per session (no new
    warning code; spec 03 §8 updated).
13. **Default storage:** the core must not import `eharness/storage/memory`, so it keeps a private
    copy of the memory adapters (`src/session/memory-storage.ts`); both copies run the
    conformance suites. Default adapters are shared by all sessions of one agent.
14. **`W_CACHE_BUST`** compares the provider-visible prefix (system blocks + active tool names)
    with the previous step of the same turn and warns at most once per turn; changes across turns
    (e.g. a `refresh: 'turn'` source) are not reported.
15. **Plain estimates (until P3):** `stats()`, `data-eh.context` and the guard's hard cap use
    `ceil(JSON length / 4)`; over the hard limit the turn ends with `EH_CONTEXT_OVERFLOW` before the
    model call (no truncation yet).
16. **`SessionOptions.parent.depth > 8`** is rejected when the session opens (`ready()` / run
    error), keeping `agent.session()` free of throws besides a non-string id (spec 05 §1 updated).
17. **P1 fix:** the core `eh.event` schema required `data` (zod 4 `z.unknown()` is not optional in
    objects), so `inject('eh.event', { name, text })` and stored events without `data` failed
    validation; fixed in `src/messages/kinds.ts` (P1 folder, one line).
18. **Not done (optional P1 note):** the `nextId` burst behaviour with a per-call floor
    (`src/messages/ids.ts:66`) is unchanged; ordering is correct and the folder is not P2's.
19. **Waiting input vs limits (review):** input waiting at a would-be `'complete'` continues the
    loop only below the step budget and the cost cap, else the stop becomes `'max-steps'` /
    `'cost-cap'` (spec 05 §3.1 updated).
20. **Interrupted calls on the stream (review):** open, non-pending tool calls are answered with
    `tool-output-error { errorText: INTERRUPTED_TURN }` chunks before `message-metadata`; the
    `onEnd` patch stays as a safety net (spec 05 §3 step 16 updated).
21. **Preparation order (review):** code follows spec 05 §3 (5 options, 6 sources, then the
    `toolsContext` check, 7 normalize, 8 `input.submit`); the `toolsContext` check needs the
    resolved tool set, stated in step 5.
22. **`state.core.usage.turns`** counts turns that ran at least one model step (a blocked turn with
    `persist` does not count; spec 05 §7 updated).
23. **State of failed preparations:** plugin state changed by hooks before the commit point is
    restored from a checkpoint when the turn ends early (taken after the context load).
24. **`turn.beforeEnd` results** that are not actionable for the stop (e.g. `extendSteps` for
    `'complete'`) are ignored silently and do not count toward `maxContinues`.

## Requests to other phases

- From P1: boot state via `getAgentInternals(agent)` (`src/agent/internals.ts`). Reuse
  `project()` (`src/messages/project.ts`), `validateStoredMessages()` (`src/messages/validate.ts`,
  returns warnings to emit), `answerDanglingToolParts()` (`src/messages/tool-parts.ts`),
  `sanitizeModelMessages()` and `describeModel()` (`src/internal/model.ts`, the format of
  `metadata.eharness.model`). Session/storage/run types are declared in
  `src/agent/session-types.ts` — implement against them (move if you like, keep the exports).
  `agent.session()` currently throws `EH_NOT_IMPLEMENTED`. `describeError` is still to do.
  The id generator ignores the floor when `config.generateId` is custom.
- From P1 (review): warn (e.g. `W_...` via the agent emitter, or a log) when a custom
  `config.generateId` returns an id that does not sort after the session floor (spec 03 §8).
- From P1 (review): remove `EH_NOT_IMPLEMENTED` from `agent.session()` (and any other stub) before
  any release — spec 10 §1 says it must not exist in a release.
- From P1 (review): `project()` answers pending client tool calls like any call without a result;
  patch pending parts in the stored message (respond / onNewInput deny) before projecting.
- From P1 (re-review, minor): `nextId` bumps the timestamp whenever `floorMs >= lastMs`, also when
  the floor is the generator's own last id in the same millisecond, so bursts with a per-call floor
  advance 1 ms per id instead of using the counter. Ordering is correct; optionally bump only when
  the floor sorts after the last issued id (`src/messages/ids.ts:66`).

Handled in P2: `agent.session()` works (no `EH_NOT_IMPLEMENTED`); `describeError` implemented
(`src/stream/describe-error.ts`); custom `generateId` floor warning (open question 12); pending
client tool calls are never projected with a stale `pending` (open question 4, P7 finishes it).
