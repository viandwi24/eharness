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
into compaction (coordinate via "Requests" if larger changes are needed).

## Checklist

1. [ ] `tokens.ts`: default counter, per-message cached estimate (`metadata.eharness.tokens`),
   calibration factor from `usage.inputTokens` (EMA, clamp 0.5–2), `ContextStats`.
2. [ ] `transcript.ts`: flat-text transcript renderer (spec 06 §5.3) + truncation rules. Golden tests.
3. [ ] `prompt.ts`: default summarizer prompt (continuation brief) + hook integration
   (`compaction.prompt`).
4. [ ] `compact.ts`: turn grouping, split (pre-turn keeps the current turn; manual; mid-turn with
   `partial`; no-input turns), `partial` carry-forward, auto-shrink, skip rule (no churn), rolling
   chunked summarization with the summarizer `contextWindow`, marker creation, commit order (save
   marker → state pointer → cache incl. injected messages), mid-turn wire rebuild excluding
   injected messages, events and transient part, `compaction.after` hooks, failure handling.
5. [ ] Triggers wired into the loop (pre-turn, mid-turn before step ≥ 1) and `session.compact()`.
6. [ ] Pointer path in `loadContext` (`load({ fromId })`) + self-healing from the paging fallback.
6a. [ ] Window per step model (`contextWindow` function), turn grouping that ignores
   `data-eh.input` and rewinds, current-turn rules for respond/regenerate/edit (spec 06 §5.1).
7. [ ] Guard: synthesized error results for dangling calls, complete hard-cap behaviour (drop oldest turns, truncate largest tool outputs in the
   wire copy, `EH_CONTEXT_OVERFLOW` stop), `W_CONTEXT_TRUNCATED`.
8. [ ] `select` escape hatch; `compaction: false`.
8a. [ ] Overflow recovery (spec 06 §7): detection patterns + `isContextOverflow`, held-back error
   chunk, recalibration, compact-and-retry once, tighter guard, `EH_CONTEXT_OVERFLOW`
   (scenario 34).
9. [ ] Integration tests: scenarios 5, 6, 7 of testing.md; crash-safety tests with a faulty adapter
   wrapper: (a) fail `save(marker)`; (b) fail the state write on the first compaction; (c) fail the
   state write when a previous pointer exists → next cold load must not resend summarized messages.
10. [ ] Golden test: mid-turn compaction followed by a pre-turn compaction keeps the `partial`
    (carry-forward) — trimmed steps never reappear.
11. [ ] Instrumented adapter test: cold load after compaction performs exactly one `load` call
    with `fromId`.

## Acceptance criteria

- [ ] A scripted 30-turn session with a small `contextWindow` compacts at the configured ratio,
      never sends a request over the hard limit, and keeps full history in storage.
- [ ] Mid-turn compaction keeps the current user message and last step verbatim; reload reproduces
      the same wire.

## Open questions

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
