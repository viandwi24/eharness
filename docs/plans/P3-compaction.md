# P3 — Context loading and compaction

Status: in progress · Branch: `phase/P3-compaction`

## Goal

The fixed compaction algorithm, token accounting with calibration, the compaction pointer for
one-query cold loads, the complete guard, `session.compact()` and `session.stats()`.

## Specs

- 06 (all)
- 05 §5 (pointer path, rewind filter), §7 (core state), §11
- 03 §5.3 (`eh.compaction`)

## Owns

`src/compaction/**`; edits in `src/session/load-context.ts` and `src/loop/**` limited to calling
into compaction (coordinate via "Requests" if larger changes are needed); the hook-point edits in
`src/session/session.ts` (token annotation in `persist()`, `stats()`, `compact()`, `TurnHost.compaction`)
and `src/session/turn.ts` (turn wire + pre-turn check) named in P2's handoff.

## Checklist

1. [x] `tokens.ts`: default counter, per-message cached estimate (`metadata.eharness.tokens`),
   calibration factor from `usage.inputTokens` (EMA, clamp 0.5–2), `ContextStats`.
2. [x] `transcript.ts`: flat-text transcript renderer (spec 06 §5.3) + truncation rules. Golden tests.
3. [x] `prompt.ts`: default summarizer prompt (continuation brief) + hook integration
   (`compaction.prompt`).
4. [x] `compact.ts`: turn grouping, split (pre-turn keeps the current turn; manual; mid-turn with
   `partial`; no-input turns), `partial` carry-forward, auto-shrink, skip rule (no churn), rolling
   chunked summarization with the summarizer `contextWindow`, marker creation, commit order (save
   marker → state pointer → cache incl. injected messages), mid-turn wire rebuild excluding
   injected messages, events and transient part, `compaction.after` hooks, failure handling.
5. [x] Triggers wired into the loop (pre-turn, mid-turn before step ≥ 1) and `session.compact()`.
6. [x] Pointer path in `loadContext` (`load({ fromId })`) + self-healing from the paging fallback.
6a. [x] Window per step model (`contextWindow` function), turn grouping that ignores
   `data-eh.input` and rewinds, current-turn rules for respond/regenerate/edit (spec 06 §5.1).
7. [x] Guard: synthesized error results for dangling calls, complete hard-cap behaviour (drop oldest turns, truncate largest tool outputs in the
   wire copy, `EH_CONTEXT_OVERFLOW` stop), `W_CONTEXT_TRUNCATED`.
8. [x] `select` escape hatch; `compaction: false`.
8a. [x] Overflow recovery (spec 06 §7): detection patterns + `isContextOverflow`, held-back error
   chunk, recalibration, compact-and-retry once, tighter guard, `EH_CONTEXT_OVERFLOW`
   (scenario 34).
9. [x] Integration tests: scenarios 5, 6, 7 of testing.md; crash-safety tests with a faulty adapter
   wrapper: (a) fail `save(marker)`; (b) fail the state write on the first compaction; (c) fail the
   state write when a previous pointer exists → next cold load must not resend summarized messages.
10. [x] Golden test: mid-turn compaction followed by a pre-turn compaction keeps the `partial`
    (carry-forward) — trimmed steps never reappear.
11. [x] Instrumented adapter test: cold load after compaction performs exactly one `load` call
    with `fromId`.

## Acceptance criteria

- [x] A scripted 30-turn session with a small `contextWindow` compacts at the configured ratio,
      never sends a request over the hard limit, and keeps full history in storage.
- [x] Mid-turn compaction keeps the current user message and last step verbatim; reload reproduces
      the same wire.

## Implementation notes

- Module layout: `tokens.ts` (counter, estimates, `metadata.eharness.tokens`, calibration, window
  and limits), `transcript.ts`, `prompt.ts`, `turns.ts` (grouping, current-turn rules, step
  helpers), `split.ts` (split + carry-forward + auto-shrink), `summarize.ts` (rolling chunks),
  `compact.ts` (session engine: skip rule, summarize, commit, manual), `turn-context.ts` (turn
  wire with segments, pre-/mid-turn triggers, guard, calibration, overflow recovery), `guard.ts`
  (hard cap), `overflow.ts` (detection + reported counts), `truncate.ts` (shared head + tail).
  All internal; no new public exports (the spec defines none), so `scripts/smoke.mjs` is unchanged.
- Hook points used in P2's runtime: `TurnHost.stats` was replaced by `TurnHost.compaction`
  (`SessionCompaction`); `persist()` annotates `metadata.eharness.tokens`; `stats()` and
  `compact()` in `src/session/session.ts`; the turn wire in `src/session/turn.ts` is built by
  `createTurnCompaction().build()` + `preTurn()`; `runSteps()` takes a `compaction` object
  instead of `stats` (mid-turn check, sanitize, hard cap, calibration, `data-eh.context`,
  held-back error chunk + overflow retry). `estimateTokens` and `DEFAULT_CONTEXT_WINDOW` moved out
  of `steps.ts` / `session.ts` into `src/compaction/tokens.ts`.
- Expected P2 test changes: the golden `two-step-turn.chunks.json` has new `data-eh.context` numbers
  (tool schemas are counted, calibration applies from step 1); stored user metadata now has
  `tokens`; `compact()` no longer rejects `EH_NOT_IMPLEMENTED`.
- Integration tests: `src/compaction/compaction.int.test.ts` (scenarios 5, 6, 7, 34, crash
  safety a–c, carry-forward golden, one-`load` cold path, manual compaction, 30-turn acceptance);
  `src/session/load-context.test.ts` (pointer path). Test helpers in `src/compaction/test-kit.ts`
  (a `doGenerate` summarizer mock, realistic usage for calibration ≈ 1).

## Open questions

1. **Order of the mid-turn trigger vs `step.prepare`.** Spec 05 §3 lists "mid-turn compaction
   check; guard; step.prepare", but a step model is only known after `step.prepare`. Chosen: the
   pre-/mid-turn triggers use the turn model's window (after `turn.prepare`); sanitize runs before
   `step.prepare`, the hard cap after it with the step model's window and settings (as P2 did).
   A step that switches to a smaller window is protected by the guard and overflow recovery.
   Recorded in spec 05 §3 step 15 and spec 06 §1/§6.
2. **Skip rule "no non-marker message".** Interpreted as "nothing that renders into the transcript"
   (e.g. only `eh.notice` / `eh.rewind` kinds is a skip), to avoid churn. Spec 06 §4 updated.
3. **Carry-forward reachability.** With the split rules of §5.1, a pre-turn compaction that keeps
   the message of the previous `partial` never has anything else to drop (a mid-turn marker's
   `resumeFromId` is the first message of that turn), so it is skipped; carry-forward only happens
   with stored markers that kept earlier messages (other versions, manual edits). Implemented and
   tested both ways (unit test + stored-data integration test; the golden integration test checks
   that trimmed steps never reappear across a mid-turn → pre-turn sequence).
4. **Calibration details** (not fixed by the spec): EMA weight 0.3 starting at k = 1; the compared
   estimate is the whole request (instructions, tools, reminders, messages); after an overflow with
   a reported count, the clamp is disabled for the session. Spec 06 §2/§7 updated.
5. **A failed automatic compaction is not retried in the same turn** (a broken summarizer would
   otherwise be called before every step); the guard takes over. Spec 06 §4 updated.
6. **Manual `compact()` exclusivity:** sets the running flag, acquires the `SessionLock`, rejects
   `EH_SESSION_BUSY` for a live foreign `activeTurn`, returns `null` when skipped or with
   `compaction: false`. Spec 06 §4 updated.
7. **Pointer without a boundary in its range** (history changed behind our back): fall back to
   paging and delete the pointer. Spec 05 §5 updated.
8. **Auto-shrink measures only the kept completed turns** (T is "never counted", §5.1), as
   implemented; spec 06 §5.2 now says so explicitly.
9. **Summarizer model in tests:** `scriptedModel` implements only `doStream`, so compaction with
   the agent's default model (no `compaction.model`) cannot be scripted; tests pass a
   `compaction.model` mock. Suggested for the owner of `src/testing` (see P8 request).

## Requests to other phases

- From P1: the guard's sanitize step exists as `sanitizeModelMessages()`
  (`src/messages/sanitize.ts`); `CompactionConfig`, `CompactionPayload` and `ContextStats` types
  are declared in `src/agent/types.ts` / `src/messages/types.ts`. Projection already honours
  `partial` and the newest boundary.

- From P2: hook points are marked in the code. Pre-turn compaction goes after `turn.start` in
  `src/session/turn.ts` (`// pre-turn compaction check: P3`); the mid-turn check and the full guard
  go at the top of each step in `src/loop/steps.ts` (today: `sanitizeModelMessages` + a hard-cap
  stop with `EH_CONTEXT_OVERFLOW`, using `estimateTokens` = `ceil(JSON length / 4)`).
  `session.stats()`, `data-eh.context` and the guard share `host.stats()` in
  `src/session/session.ts` (plain estimates, `W_DEFAULT_CONTEXT_WINDOW`); replace with calibrated
  accounting and `metadata.eharness.tokens`. `session.compact()` is a stub that rejects
  `EH_NOT_IMPLEMENTED` (after the busy check) — remove it. `loadContext`
  (`src/session/load-context.ts`) always pages; add the pointer path (`state.core.compaction`,
  already healed there). Overflow recovery needs the raw step error: `streamText`'s `onError` in
  `steps.ts` currently only logs it, and error chunks are forwarded immediately (hold back an
  `error` chunk that arrives before the step's first `start-step`). Mid-turn wire rebuilds must
  keep `turnStart` (the turn reminder position) consistent.
