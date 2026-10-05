# ADR-0020: Pre-compaction flush

Status: **Proposed** · Date: 2026-10-05 · Amends ADR-0004

## Context

Summarizing is lossy: facts the summary leaves out are gone from the model's context. Agents with
long-term memory (spec 14) want one last chance to write those facts down before compaction.
Other harnesses run a "memory flush" turn before compacting. eharness must offer this without
breaking its invariants: stored order equals model order (ADR-0011), compaction output is data
(ADR-0005), and the prompt-cache prefix stays stable (ADR-0013).

## Decision

- **A hook, not a strategy.** `compaction.before` (chainable) may return `{ flush: { prompt,
  tools?, maxSteps?, model? } }`. Compaction stays one fixed algorithm (ADR-0004); the flush is a
  step inside it that runs only when summarizing will really happen (after the split, the skip
  rule, prune and the budget check).
- **A separate internal call, not a visible turn.** The flush is one `generateText` call over the
  current wire plus the prompt, with the turn's (wrapped) tools filtered to a whitelist. A visible
  turn would add messages the model later sees, change the turn's step count and progress window,
  and stream tool calls into the user's UI. The internal call has none of that; its effects exist
  only through tool side effects (memory files).
- **An audit record instead of no trace.** The core stores one model-invisible `eh.flush` kind
  message (metadata only: trigger, prompt, model, steps, tool names and statuses, usage, cost,
  error) before the marker. It never reaches the model (projection `omit`), so the conversation
  is unchanged, but audits and UIs can see that a flush ran, what it did and what it cost. Tool
  inputs and outputs are not stored (they may be large or sensitive; `tool.after` sees them).
- **Approvals are auto-denied.** Nobody waits for an answer in the middle of a compaction, and a
  pending approval cannot be expressed inside an internal call. Calls that would need approval are
  denied with a fixed reason and reported to `approval.decided` (`by: 'policy'`); automatic
  approvals still apply. Rule-based grants may revisit this.
- **Skipped when it cannot fit.** The flush sends the whole current context, so it needs the
  flush model's window to hold it plus the output reserve. After a provider "too long" error the
  context is known not to fit the turn model, so the flush runs only with a model that has a
  larger window (`W_COMPACTION_FLUSH_SKIPPED` otherwise). Compaction itself always proceeds.
- **Charged like the summarizer.** Usage goes through the nested-usage path with `source:
  'compaction-flush'` (turn usage, cost and budgets; manual `compact()`: session usage).
- **Failure is not fatal.** A failing flush is `W_HOOK_FAILED` (`phase: 'flush'`), recorded with
  `error`, and compaction continues; only an abort of the turn aborts both.

## Consequences

- A flush costs one extra model call per compaction over a mostly cached prefix (block 1 + 2 and
  the current wire are unchanged).
- `HarnessHooks` gains `compaction.before`; `HarnessKindTypes` / `HarnessDataTypes` gain
  `eh.flush` (exhaustive switches over core kinds must add a case).
- The memory plugin builds `flushOnCompaction` on this hook only (ADR-0008 dogfooding).
