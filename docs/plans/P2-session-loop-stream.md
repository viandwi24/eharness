# P2 — Session, loop, streaming, storage contracts

Status: todo · Branch: `phase/P2-runtime`

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

1. [ ] Contracts: `MessageAdapter`, `StateAdapter` (incl. optional `setIf`, `rev`), `SessionLock`,
   `SessionStateSnapshot`, `PluginState` (namespaced, dirty tracking).
2. [ ] `storage/memory.ts`: `memoryMessages()`, `memoryState()` (deep copies on read/write).
3. [ ] `testing/`: `messageAdapterConformance`, `stateAdapterConformance`, `scriptedModel` (wraps
   `MockLanguageModelV4`, records prompts), run both suites against memory adapters.
4. [ ] Session cache in the agent (`session()`, `closeSession()`, `close()`, idle eviction).
5. [ ] Session open: state load, plugin `session()` phases in order, services wiring, `ToolInput`
   function resolution, `session.start` hooks, dispose on close.
6. [ ] `HarnessContext` implementation with live getters (turn, step, stream).
7. [ ] Turn lifecycle exactly as spec 05 §3 (sync busy flag, everything else inside `execute`,
   lock, `lastId` validation before writes, preparation vs commit point, input normalization,
   `input.submit` (rewrite/block/context, fail closed), `turn.prepare`, `SendOptions` overrides
   (`model`, `settings`, `options` validated by `callOptions`, `maxSteps`, `toolsContext`
   validation), failure semantics: only `EH_SESSION_BUSY`/`EH_SESSION_CLOSED` throw) +
   `session.ready()`.
7a. [ ] Stop rules of spec 05 §3.1 incl. `turn.beforeEnd` (`continue`, `extendSteps`,
   `maxContinues`), `turnTimeoutMs` → `'timeout'`, AI SDK step timeouts → `'timeout'`,
   `'blocked'`; dangling tool calls answered at the end of aborted/timed-out/failed turns.
7b. [ ] Crash recovery (spec 05 §9): `state.core.activeTurn` at the commit point, heartbeat,
   stale detection (lock or `staleMs`), recovery patch + `eh.notice`, `recovery: false`.
7c. [ ] Step-boundary delivery of `data-eh.input` (used by `step.end` `context`, `turn.beforeEnd`
   and — in P7 — steers and `next-step` injections).
8. [ ] Loop: one `streamText` per step with `instructions` (not `system`), `stopWhen:
   isStepCount(1)`, wire accumulation from guarded `await result.responseMessages`, `step.prepare`
   (model, settings, activeTools, toolChoice, reminder, providerOptions, messages) / `step.end`
   hooks, settings pass-through (`timeout` without `totalMs`, `streamRetries` with `reset-step`,
   `repairToolCall`), telemetry pass-through, `ctx.turn.addUsage`. Call `registry.toolsForStep(discovered)` every step and collect
   discovered names from `tool_search` results (spec 02 §3.3) — P6 adds deferral itself.
9. [ ] Tool wrapping: `tool.before` via `experimental_refineToolInput`; execute wrapper with
   `tool.after`, preliminary (AsyncIterable) pass-through, `HarnessToolError`, status part;
   approval function plumbing (`toolApproval` built from policy + `tool.approve`; the pending /
   respond flow itself is P7). No `needsApproval` in eharness code.
10. [ ] Stream exactly as spec 04 §2: `start` with metadata, per-step `for await … writer.write`
    (no `merge`), `onError` on **both** `createUIMessageStream` (`describeError`) and
    `toUIMessageStream` (`uiErrorText`: `String(e)` for `HarnessToolError`), step `abort` chunks
    dropped, `setOutcome`, `message-metadata` + `finish` | `abort`; chunk cloning for the turn
    buffer and `run.stream`.
11. [ ] Persistence via `createUIMessageStream({ onStepEnd, onEnd })` → `message.beforeSave` →
    `save`; per-step barrier resolved by `onStepEnd`; end sequence in `onEnd` with the
    `committed` flag (spec 05 §3 steps 15–17); tee with a core-drained branch (spec 04 §5);
    transient parts excluded; fixed texts module (spec 10 §5).
12. [ ] `PluginStreamWriter` (namespacing, transient defaults, outside-turn behaviour, warnings).
13. [ ] Turn buffer + `attach()`; `events()` channel; `inject()`; `abort()`; `messages()`;
    `HarnessRun.toResponse()` / `pipeTo()`.
14. [ ] Context load (paging fallback, validation policy, boundary ordering) + hot cache +
    `lastId` check.
15. [ ] Prompt layout and caching (spec 02 §5–§6): two system blocks, turn/step reminders (never
    stored), `toolOrder`, `cache` modes gated to Anthropic models, `W_CACHE_BUST`, usage cache
    fields in metadata.
16. [ ] Integration tests: scenarios 1–4, 7 (sanitize part), 10–15, 27–31, 33, 35, 36 of testing.md.
17. [ ] `scripts/smoke.mjs`: run one scripted two-step turn under Node.

## Acceptance criteria

- [ ] A turn with 2 steps (tool call → answer) saves the assistant message 3 times (after step 0,
      after step 1, final with metadata) with the same id and ends with correct
      `metadata.eharness` (usage, stop, steps, durationMs).
- [ ] Golden test of the exact chunk sequence of that turn passes 100 times in a row (no
      interleaving flakiness).
- [ ] Reloading with a new agent instance and the same memory adapters reproduces the same model
      wire for the next turn (round-trip test).
- [ ] `run.result` never rejects for model/tool errors; `EH_SESSION_BUSY` on concurrent send.
- [ ] Node smoke test passes in CI for 22 and 24.

## Open questions

## Requests to other phases
