# Spec 06 — Compaction

Status: **Accepted** (v0). Module: `src/compaction`.

Compaction is **fixed** (ADR-0004): one well-tested algorithm with a few knobs. The extension point
is storage (spec 05), not the strategy. The output of compaction is **data** — an `eh.compaction`
kind message — so any `MessageAdapter` stores it without knowing what compaction is (ADR-0005).

## 1. Configuration

```ts
export interface CompactionConfig {
  /** Summarize when projected context exceeds this ratio of contextWindow. Default 0.75. */
  summarizeAt?: number
  /** Most recent COMPLETED turns kept verbatim (the current turn is always kept). Default 4. */
  keepLast?: number
  /** Summarizer model. Default: agent model. A cheaper model is recommended. */
  model?: LanguageModel
  /** Summarizer context window. Default: agent contextWindow for the summarizer model. */
  contextWindow?: number
  /** Replace the default summarizer instructions. Hooks can still add context. */
  prompt?: string
  /** Max tokens for the summary. Default 4_000. */
  maxSummaryTokens?: number
  /** Token counter. Default: ceil(chars / 4), calibrated by provider usage (§2). */
  countTokens?: (text: string) => number
  /** Escape hatch: final say over the assembled view, before the guard (§6). */
  select?: (view: HarnessUIMessage[], ctx: HarnessContext) => HarnessUIMessage[]
}
```

`compaction: false` disables summarization; the guard (§6) and overflow recovery (§7, without
the compaction step) still run.

**Window.** The window is resolved per step from the model of that step:
`config.contextWindow` (number, or function of the model; spec 01 §1), else 128k with
`W_DEFAULT_CONTEXT_WINDOW`. A turn or step that switches to a model with a smaller window is
checked against the smaller window before the call (mid-turn trigger, guard).

Guard settings: `config.guard?: { maxContextRatio?: number /* 0.9 */; reserveTokens?: number /* settings.maxOutputTokens ?? 8% of window */ }`.

## 2. Token accounting

- Each stored message caches `metadata.eharness.tokens` = estimate of its projection (including
  `data-eh.input` parts, which project to user messages), computed when saved. For a message trimmed by a `partial` (§3) the trimmed projection is used. Context
  size = instructions + tool definitions + Σ message tokens.
- Calibration: after each step the core compares provider-reported `usage.inputTokens` with the
  estimate for the same wire and keeps a factor `k = clamp(actual / estimate, 0.5, 2)` (exponential
  moving average, in memory). All estimates are multiplied by `k`.
- `session.stats()` and the transient `data-eh.context` part (after each step) return:

```ts
export interface ContextStats {
  window: number
  tokens: number                 // calibrated estimate of the next request
  instructions: number
  tools: number
  messages: number
  summarizeAt: number            // absolute tokens
  hardLimit: number              // absolute tokens (§6)
  lastCompaction?: { markerId: string; before: number; after: number; at: number }
}
```

## 3. Marker payload

```ts
interface CompactionPayload {
  summary: string
  /** First message (id order) kept verbatim after this marker; null = nothing kept (manual only). */
  resumeFromId: string | null
  /** Inside `messageId`, drop steps before `fromStep` when projecting (mid-turn, or carried forward). */
  partial?: { messageId: string; fromStep: number }
  tokens: { before: number; after: number }
  trigger: 'auto' | 'manual' | 'turn'
  model?: string
}
```

Stored as kind `eh.compaction` (spec 03 §5.3): role `user`, boundary, projected as
`<conversation-summary>…</conversation-summary>`. Steps inside an assistant message are delimited
by its `step-start` parts; step `n` = the parts after the `n`-th `step-start` (0-based).

## 4. Triggers

| Trigger | When | `trigger` |
|---|---|---|
| Pre-turn | inside the turn stream, after the user message is saved and context loaded, if tokens > summarizeAt | `turn` |
| Mid-turn | before each step ≥ 1, if tokens > summarizeAt (at most once per step) | `auto` |
| Manual | `session.compact()` (idle only) | `manual` |

During compaction the core writes `data-eh.status { state: 'compacting' }` (transient) and a
transient `data-eh.compaction` part with the marker payload, so live UIs can show a divider.

**Skip rule (no churn):** compaction is skipped — and the guard handles the size — when the part to
summarize (`drop`, §5.1) contains no non-marker message, or when the estimated result (summary
budget + kept part + instructions + tools) would not be below `summarizeAt`.

## 5. Algorithm

### 5.1 Split

**Turn grouping** (used here and by the guard): walk the view in order — the view already
excludes messages hidden by rewinds (spec 11 §5) — and start a turn at every `role: 'user'`
message that is **not** a kind message. `data-eh.input` parts (steers, spec 11 §6) live inside an
assistant message and never start a turn; `eh.rewind` markers are kind messages and never start
one either. Kind messages and the boundary marker before
the first such message belong to the first turn. The **current** turn, if started by `send()`
without input, starts at the first kind message after the previous turn's assistant message (the
injected events that motivated it), or at its own assistant message if there is none. In stored
history such past no-input turns simply merge into the previous turn (harmless: they are kept or
summarized together).

The current turn of the other operations (spec 11):

| Operation | Current turn T |
|---|---|
| `respond()` | the turn of the continued assistant message A (from its user message through A) |
| `regenerate()` | the turn of the re-answered user message (the old answer is hidden by the rewind) |
| `edit()` | starts at the new user message (the old one is hidden) |

**Pre-turn** (current turn T as defined by the grouping rule; its first message is the user
message just saved, or — without input — the injected kind messages or the new assistant message):

```
keep = T (always, never counted) + the last `keepLast` completed turns (auto-shrink §5.2)
drop = previous marker's summary + every earlier message
resumeFromId = id of the first message in keep            (never null for pre-turn)
```

**Manual** (idle): same as pre-turn without T; if `keepLast` shrinks to 0, `resumeFromId = null`.
When the session is pending (spec 11 §2), the turn of the pending message is kept like a current
turn (never summarized, so `respond()` still finds its parts).

**Mid-turn** (turn T running; its assistant message A has completed steps 0..s):

```
keep = the first message of T (user message, or first kind message of T, or A) + step s of A
drop = previous marker's summary + earlier turns + steps 0..s-1 of A
resumeFromId = id of the first message of T
partial      = { messageId: A.id, fromStep: s }
```

**Carry forward:** if the previous marker has `partial` and `partial.messageId` is inside `keep`,
the new marker copies that `partial` (unless mid-turn sets a newer one for the same message).
This keeps already-summarized steps from reappearing verbatim.

Splits happen only at turn boundaries (pre-turn/manual) or step boundaries (mid-turn), so tool
calls are never separated from their results.

### 5.2 Auto-shrink

If the kept part exceeds 25% of the window, reduce the number of completed turns kept one at a time
down to 0 (the current turn is never removed). Mid-turn keeps exactly the last completed step; if
that step alone exceeds 25% of the window, its tool outputs are truncated in the summarizer
transcript and the guard handles the wire.

### 5.3 Summarize

1. Render `drop` as a **flat text transcript** (never raw tool messages — some providers continue
   the markup instead of summarizing):
   - the previous summary first, as `PREVIOUS SUMMARY:`,
   - user/assistant text as `USER:` / `ASSISTANT:` lines,
   - tool calls as `TOOL <name>(<json input, truncated 500 chars>) → <output, truncated 2_000 chars>`,
   - reasoning dropped, file parts as `[file <mediaType> <name>]`,
   - `data-eh.input` parts as `USER:` lines (source `event` / `plugin:*` as `EVENT:` / `NOTE:`),
     in place,
   - other data parts via their `model` projection (omitted ones dropped), kinds via their
     projection.
2. Hooks `compaction.prompt` add `context` lines (e.g. files in progress) or replace the prompt.
3. `generateText({ model, instructions: prompt, prompt: transcript + context, maxOutputTokens: maxSummaryTokens })`.
4. If the transcript exceeds 60% of the summarizer `contextWindow`, summarize in sequential chunks,
   feeding the running summary into the next chunk (rolling).

Default prompt (outline; exact text lives in `src/compaction/prompt.ts`): produce a continuation
brief — goal and constraints from the user, decisions made, current state of the work, open
questions, next steps, important identifiers (files, ids, names) — written so the agent can
continue without the old messages. No tool markup.

### 5.4 Commit

```
marker = kind message eh.compaction (UUIDv7, newer than everything)
save(marker)                                             ← adapter.save, one row
state.core.compaction = { markerId, resumeFromId }; persist state
cache = [marker] + every cached non-boundary message with id >= (resumeFromId ?? marker.id)
mid-turn only: rebuild the wire from the new view, EXCLUDING non-marker messages with
               id > A.id (injected during the turn — they belong to the next turn, spec 03 §5.4)
emit session event { type: 'message', message: marker }; hooks compaction.after
```

Crash safety: if the process dies after the summary is generated but before `save(marker)`,
nothing changed — the next load compacts again. If it dies after `save` but before the state write,
the loader (spec 05 §5) finds the newer marker in the range and heals the pointer — with or without
a previous pointer.

### 5.5 Failure

Summarizer error or empty output → warning `W_COMPACTION_FAILED`, no marker, continue with the
guard. Manual `compact()` rejects with `EH_COMPACTION_FAILED`.

## 6. Guard (always on, not configurable away)

Runs before every step, on the **UI view** (grouped into turns as in §5.1), then re-projects. For
the in-turn part of the wire (response messages appended by the loop), the loop records the wire
index where the current turn starts.

1. **Sanitize** (ADR-0014):
   - a tool call without a result gets a synthesized error result
     (`{ type: 'error-text', value: INTERRUPTED_UNKNOWN }`, spec 10 §5) instead of being removed —
     the model learns the call did not complete instead of silently losing it; the only
     exceptions are the calls whose `tool-approval-response` ends the wire of a `respond()`
     continuation's first step (AI SDK executes those);
   - a tool result without a call is removed;
   - empty messages are removed.
2. **Hard cap:** limit = `window × maxContextRatio − reserveTokens`. While over the limit:
   1. drop the oldest whole completed turn after the boundary (warning `W_CONTEXT_TRUNCATED`);
   2. when only the current turn remains, truncate the largest tool outputs in the wire copy (not
      in storage) with the `TOOL_OUTPUT_TRUNCATED` helper (spec 09 §4);
   3. if still over → end the turn with `stop: 'error'`, error code `EH_CONTEXT_OVERFLOW`.

The guard only changes the wire, never stored messages. Truncation uses the same head + tail
helper as tool output limits (spec 09 §4).

## 7. Overflow recovery

Token estimates can be wrong (images, provider tokenizers). When the provider rejects a request
because the context is too long, the core recovers instead of failing the turn:

1. **Detect.** The core's `onError` for `toUIMessageStream` records the raw error of the step.
   An `error` chunk that arrives **before the step's first `start-step`** (the provider call
   failed before streaming) is held back until the core has decided. The error is an overflow
   when, walking the error and its `.cause` chain, some error has an HTTP status (`statusCode` or
   `status`: 400 or 413 — `APICallError`, gateway errors and others) **and** a message or response
   body matching the built-in patterns (`prompt is too long`, `context_length_exceeded`,
   `maximum context length`, `too many tokens`, …; list in `src/compaction/overflow.ts`), or when
   `config.isContextOverflow?(error)` returns true.
2. **Recalibrate.** If the provider reports the actual token count, set `k = actual / estimate`
   (unclamped for this session); otherwise `k = k × 1.25`.
3. **Compact and retry once per turn** (`W_OVERFLOW_RETRY`): run a mid-turn compaction (pre-turn
   rules if no step completed yet) ignoring `summarizeAt` but keeping the skip rule, then retry the
   same step. The held-back error chunk is discarded.
4. **Tighter guard.** If the retry overflows again (or compaction was skipped or disabled), run
   the guard with `maxContextRatio × 0.8` and retry once more.
5. **Give up.** Forward the error, end the turn with `stop: 'error'` and `EH_CONTEXT_OVERFLOW`.

Overflow errors that arrive after streaming started are not retried (the partial output has
already been delivered).

## 8. What compaction never does

- Delete or rewrite stored messages (history stays complete for UIs and audits).
- Summarize messages hidden by a rewind.
- Run while another compaction for the same session is running.
- Change the instructions or the tool set.
