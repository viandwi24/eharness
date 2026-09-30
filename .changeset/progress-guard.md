---
"eharness": minor
---

**Long-running turns** (ADR-0015, spec 05 §3.1–3.2):

- **BREAKING (defaults):** `loop.maxSteps` defaults to 500 (was 50); `loop.maxTurnOutputTokens` and
  `loop.maxContinues` default to none (were 100_000 and 3). Migration: set them explicitly to keep
  the old limits.
- **New:** when the step budget runs out, one wrap-up step without tools asks the model for a
  summary of what is done and what is left (`loop.wrapUp`, default `true`; the stop stays
  `'max-steps'`). New fixed text `MAX_STEPS_WRAP_UP`.
- **New:** progress guard (`loop.progress`): the same tool call with the same result 3 times in the
  last 20 tool steps, or 5 steps whose tool calls all failed, gets one reminder (`PROGRESS_NUDGE`,
  warning `W_LOOP_STUCK`) and then stops the turn with the new stop reason `'stuck'`.
  `loop.progress: false` disables it.
- **New:** `turn.beforeEnd` continuations are bounded by progress: after `loop.maxIdleContinues`
  (default 3) continuations in a row without a new successful tool result, further continuations
  are refused (`W_CONTINUE_LIMIT` with `details.reason: 'no-progress'`). The hook event has a new
  `idleContinues` field.
- `StopReason` gains `'stuck'` (exhaustive switches over `StopReason` need a new case).
