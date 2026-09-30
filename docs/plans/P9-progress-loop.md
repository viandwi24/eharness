# P9 — Progress-bounded loop

Status: done · Owner: agent · Branch: `feat/long-running`

## Goal

Turns can run for hours without a small step cap, while a model that repeats itself or keeps failing
is stopped early, and `turn.beforeEnd` continuations are bounded by progress (ADR-0015).

## Specs

- `docs/specs/05-session-and-storage.md` §3.1, §3.2 (new)
- `docs/specs/01-agent-and-plugins.md` §1 (`LoopConfig`, `ProgressConfig`), §5 (`turn.beforeEnd`)
- `docs/specs/10-errors-and-stop-reasons.md` §2, §4, §5

## Owns

`src/loop/progress.ts`, `src/loop/steps.ts`, `src/session/turn.ts` (loop options), texts, types.

## Checklist

- [x] Defaults: `maxSteps` 500, `maxTurnOutputTokens` / `maxContinues` none
- [x] Wrap-up step (`loop.wrapUp`, `MAX_STEPS_WRAP_UP`, `toolChoice: 'none'`)
- [x] Progress tracker (repeat by tool+input+output key, window, error streak, ignoreTools)
- [x] Nudge (`PROGRESS_NUDGE` step reminder, `W_LOOP_STUCK`), then stop `'stuck'`
- [x] Idle continuations (`loop.maxIdleContinues`, `idleContinues` in the hook event)
- [x] Unit tests (`progress.test.ts`) and integration tests (`hooks.int.test.ts`)
- [x] Specs, ADR-0015, changeset

## Acceptance criteria

- [x] A repeating model gets one reminder and stops with `'stuck'`; `progress: false` disables it
- [x] Continuations without progress are refused after `maxIdleContinues`
- [x] `max-steps` runs one tool-less wrap-up step by default
- [x] lint, typecheck, test green

## Open questions

- Compaction thrashing (context full again within ~2 steps after a compaction) is not detected yet.
- Unlimited retry of 429/529 for unattended runs is left to `settings.maxRetries` / the app.
