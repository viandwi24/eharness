# Spec 06 — Compaction

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Module: `src/compaction`.

Compaction is **fixed** (ADR-0004, amended by ADR-0019): one well-tested algorithm with a few
knobs; the prune stage (§5.0) is a setting of it, not a strategy. The extension point
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
  /** View-only pruning of old tool outputs (§5.0). Default off; `{}` = on with defaults. (0.4.0) */
  prune?: PruneConfig | false
  /** Thrash detection (§4). Default { withinSteps: 2 }; false = compact again (0.3). (0.4.0) */
  thrash?: { withinSteps?: number } | false
}

export interface PruneConfig {
  /** Completed turns (newest first) whose tool outputs are never pruned. Default 2. The current turn is never pruned. */
  keepTurns?: number
  /** Only outputs whose projected size exceeds this many characters are pruned. Default 2_000. */
  minChars?: number
  /** Final tool names never pruned. */
  exclude?: string[]
  /** Placeholder text (pure). Default TOOL_OUTPUT_PRUNED (`[output of <tool> pruned: <n> chars]`). */
  replaceWith?: (part: ToolResultPart) => string   // AI SDK ToolResultPart (ADR-0001)
}
```

`prune.keepTurns` must be an integer ≥ 0 and `prune.minChars` a number ≥ 0
(`EH_CONFIG_INVALID` otherwise, spec 01 §7).

`compaction: false` disables summarization; the guard (§6) and overflow recovery (§7, without
the compaction step) still run.

**Window.** The window is resolved per step from the model of that step:
`config.contextWindow` (number, or function of the model; spec 01 §1), else the `models` catalog
entry (spec 12 §1), else 128k with
`W_DEFAULT_CONTEXT_WINDOW` (once per model and session). A turn or step that switches to a model
with a smaller window is checked against the smaller window before the call: the pre-turn and
mid-turn triggers use the turn's model (after `turn.prepare`); the guard's hard cap runs after
`step.prepare` and uses the step's model.

Guard settings: `config.guard?: { maxContextRatio?: number /* 0.9 */; reserveTokens?: number /* settings.maxOutputTokens ?? 8% of window */ }`.

## 2. Token accounting

- Each stored message caches `metadata.eharness.tokens` = estimate of its projection (including
  `data-eh.input` parts, which project to user messages), computed when saved (after
  `message.beforeSave`). For a message trimmed by a `partial` (§3) the trimmed projection is used. Context
  size = instructions + tool definitions + Σ message tokens.
- Estimate of model messages: `countTokens` of every text / reasoning part, tool name + JSON input
  of tool calls, tool name + output of tool results; a fixed 1_500 per file / image part; 4 per
  message. Tool definitions: name + description + JSON schema of the input + 10. Instructions:
  block 1 + block 2 (+ the turn reminder inside a turn).
- Calibration: after each step the core compares provider-reported `usage.inputTokens` with the
  estimate of the same request (instructions, tools, reminders, messages) and keeps a factor
  `k = clamp(actual / estimate, 0.5, 2)` (exponential moving average with weight 0.3 for the new
  sample, starting at 1, in memory per session). All estimates are multiplied by `k`.
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
  /** Prune stage (§5.0): outputs replaced and characters saved; present only when prune is on. */
  pruned?: { outputs: number; chars: number }
}
```

With prune on, `messages` reflects the **pruned** wire: the turn's `data-eh.context` measures the
request it built; `session.stats()` (idle) measures the next request, in which every completed
turn except the newest `keepTurns` is pruned. The saving of a message (estimate of its projection
minus the estimate of its pruned projection) is computed once per stored message and cached for
the session; `metadata.eharness.tokens` stays the unpruned estimate.

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

**Order per check (prune on):** prune → recompute the estimate → summarize only if still above
`summarizeAt` (then, 0.4.0, the flush of §5.2a runs right before the summarizer). The wire is built with the prune stage applied (§6), so the pre-turn and mid-turn
triggers measure the pruned size; the skip rule's kept part is measured pruned too. The guard runs
after, unchanged.

**Skip rule (no churn):** compaction is skipped — and the guard handles the size — when the part to
summarize (`drop`, §5.1) contains no non-marker message (precisely: nothing that renders into the
transcript of §5.3 besides the previous summary), or when the estimated result (summary
budget + kept part + instructions + tools) would not be below `summarizeAt`. The `compacting`
status is written only when the skip rule passed.

An automatic compaction that failed (§5.5) is not retried in the same turn; the guard takes over.

**Thrash (0.4.0).** After a successful automatic compaction (pre-turn = step 0, mid-turn before
step `s` = step `s`, overflow recovery = the step being retried) the core remembers its step
index. When the mid-turn check before step `n` finds the context above `summarizeAt` again
(after prune) and `n − that index ≤ thrash.withinSteps` (default 2), the core does **not** compact
again: it raises `W_CONTEXT_THRASH` (`details: { stepIndex, tokens, summarizeAt, lastCompaction }`)
and stops the turn with `'context-thrash'` before the next model call. `turn.beforeEnd` does not
run; dangling calls are answered as usual; an `eh.notice` (level `warning`, code
`EH_CONTEXT_THRASH`) is saved (spec 05 §3.1). `thrash: false` restores 0.3 behaviour (compact
again; the failed-compaction rule above still applies). `thrash.withinSteps` must be a positive
integer.

**Manual** `compact()` is exclusive like a turn: it sets the running flag (a `send()` meanwhile
throws `EH_SESSION_BUSY`), acquires the `SessionLock` when configured, validates the hot cache like
a turn, and rejects `EH_SESSION_BUSY` when a live turn of another instance owns the session
(`activeTurn` with a fresh heartbeat). It resolves `null` when it was skipped or when
`compaction: false`. Outside a turn the transient `data-eh.compaction` part is delivered as a
session `data` event.

## 5. Algorithm

### 5.0 Prune (0.4.0, off by default)

With `compaction.prune` set, old and large tool outputs are replaced by a short placeholder in
the request — cheaper than summarizing and friendly to the prompt cache — before the summarizer
is considered. Normative rules:

1. **View-only.** Prune runs when the turn wire is built from the view (turn start and after a
   compaction, §6): it is applied to the projection of every completed turn (§5.1 grouping)
   except the newest `keepTurns`. The current turn is never pruned. Stored messages,
   `metadata.eharness.tokens` and UI history are never changed.
2. **Deterministic.** Whether an output is pruned depends only on its turn's distance from the
   current turn, its size and its tool name. Same view → same wire, byte for byte. Size = the
   projected output in characters: `text` the string length, `json` the serialized JSON length,
   `content` the sum of its text items plus the serialized length of other items. Only outputs
   with size > `minChars` are pruned. `replaceWith` must be pure; its result replaces the output
   as `{ type: 'text', value }` (a throwing or non-string `replaceWith` falls back to the default
   placeholder). `error-text`, `error-json` and `execution-denied` results are never pruned —
   they are short and carry meaning. Tools named in `exclude` are never pruned.
3. **Pairs stay intact.** Only the `output` of a `tool-result` part of a `tool` message is
   replaced; the `tool-call` and the result part stay (ids, names, inputs unchanged). Tool inputs
   are not pruned. Provider-executed results (inside assistant messages) are left alone (their
   format is provider-specific).
4. **Order per check:** prune → recompute the estimate → summarize only if still above
   `summarizeAt` (§4). The guard (§6) runs after, unchanged.
5. **Cache cost.** The wire is rebuilt at turn start, so when a turn ages past `keepTurns` the
   prefix changes **once per turn**, at the oldest newly pruned output; inside a turn the prefix
   is stable (completed turns do not change within a turn, so a mid-turn rebuild prunes nothing
   new).
6. **Summarizer transcript** (§5.3) uses the original outputs (capped at 2 000 characters), not
   the placeholders: the summary is where information is condensed.
7. **Accounting:** see §2 (`ContextStats.messages` reflects the pruned wire, `ContextStats.pruned`).

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
This keeps already-summarized steps from reappearing verbatim. A dropped message trimmed by the
previous `partial` enters the transcript trimmed (its early steps are already in the previous
summary); a second mid-turn compaction of the same message summarizes only the steps from the
previous `fromStep` on.

Splits happen only at turn boundaries (pre-turn/manual) or step boundaries (mid-turn), so tool
calls are never separated from their results.

### 5.2 Auto-shrink

If the kept part exceeds 25% of the window, reduce the number of completed turns kept one at a time
down to 0 (the current turn is never removed). The kept part measured here is the kept completed
turns only: the current turn T is never counted (§5.1) — it cannot shrink, and a large T is left
to the skip rule (§4) and the guard. Mid-turn keeps exactly the last completed step; if
that step alone exceeds 25% of the window, its tool outputs are truncated in the summarizer
transcript and the guard handles the wire.

### 5.2a Flush (0.4.0)

Before history is summarized (lossy), plugins can give the agent one bounded, internal chance to
save facts — typically into memory files (spec 14 §9) — through the `compaction.before` hook
(spec 01 §5) and a **flush turn** (ADR-0020). Normative rules:

1. **When.** Once per compaction, after the split (§5.1), the skip rule (§4) and the budget check
   (§5.3 item 5) decided that summarizing will happen — so after prune (§5.0) — and after the
   `compacting` status was written, before the summarizer. A used-up budget skips the
   compaction and with it the hook and the flush. Without a `compaction.before` hook nothing
   changes (0.3 behaviour and storage).
2. **Hook.** `compaction.before` receives `{ messages, tokens, trigger }`: copies of `drop`
   (§5.1, view messages, trimmed by a previous `partial`; not the previous summary, not the kept
   tail), the calibrated estimate of the current context (the payload's `tokens.before`) and
   `trigger`: `'turn'` (pre-turn), `'auto'` (mid-turn), `'manual'` (`compact()`) or `'overflow'`
   (§7; the marker's own `trigger` stays `'auto'`/`'turn'`). Hooks run in plugin order; their
   `flush` requests merge: prompts joined with a blank line, tool lists unioned (first
   appearance), `maxSteps` = max (default 3 each), `model` = last defined. A hook that throws or
   returns an invalid patch (`prompt` not a non-empty string, `tools` not an array of strings,
   `maxSteps` not a positive integer) → `W_HOOK_FAILED`, skipped.
3. **Run.** One `generateText` call with: `instructions` = block 1 + block 2 of the turn
   (the stable prefix; no turn or step reminder); `messages` = the **current wire** (the wire of
   the request that triggered the compaction, pre-compaction, guard-sanitized; manual: the
   projected view) + a user message with the merged prompt; `tools` = the turn's wrapped tools
   filtered to the whitelist, in the turn's `toolOrder` (so `tool.before` / `tool.after` / output
   limits apply; deferred tools are offered loaded; client tools and unknown names are never
   offered; none left → a text-only call); `toolsContext` of the turn; `stopWhen:
   isStepCount(maxSteps)`; `maxOutputTokens` = the turn's `settings.maxOutputTokens`. The model
   is `flush.model ?? compaction.model ?? the turn's model` (manual: the agent model). A manual
   `compact()` resolves the tools as the next turn would (dynamic sources, grants).
4. **Approval.** The turn's approval function applies (policy, risk, `tool.approve`, grants);
   every call that would ask the user (`user-approval`) is **auto-denied** with reason
   `Not available during memory flush.` (`FLUSH_APPROVAL_DENIED`) and reported to
   `approval.decided` with `by: 'policy'`. Automatic approvals and denials are reported as in a
   turn.
5. **Window.** The flush is skipped with `W_COMPACTION_FLUSH_SKIPPED` (`details: { reason:
   'window', trigger, window, tokens }`) when `tokens` + the prompt + `maxOutputTokens` (default
   8% of the window) exceed the flush model's window, and for `trigger: 'overflow'` unless the
   flush model's window is larger than the turn model's window (the provider already rejected
   the context). Compaction continues.
6. **No visible trace.** Flush messages are never saved, never added to the wire of the turn and
   never projected; the main model's later requests are byte-identical to a compaction without a
   flush. Effects exist only through tool side effects.
7. **Audit record.** After the flush the core saves a core kind message **`eh.flush`** (spec 03
   §5.3; role `assistant`, `model: 'omit'`, not a boundary) with `{ trigger, prompt, model, steps,
   toolCalls: Array<{ toolName, status: 'output' | 'error' | 'denied' }>, usage, costUsd?, error? }`
   — no tool inputs or outputs (use `tool.after` for those). It goes through `message.beforeSave`,
   is saved **before** the marker (so the marker stays the newest message), carries the running
   turn's `turnId` (manual: none) and is delivered as a session `message` event; during a turn the
   payload is also written once as a transient `data-eh.flush` chunk. Mid-turn its id is greater
   than the running assistant message: it belongs to the next turn per spec 03 §5.4 (and is
   omitted from projection anyway). A failing save is logged and does not fail the compaction.
8. **Accounting.** The flush's `totalUsage` is charged like summarizer usage (§5.3 item 5) with
   `source: 'compaction-flush'`, priced with the flush model: turn usage (`TurnResult.usage`,
   `costUsd`, budgets) during a turn, `state.core.usage` for manual. When the flush used up the
   budget, the summarizer does not run (`W_BUDGET` with `details.compaction: true`, compaction
   skipped).
9. **Failure.** A flush error (provider error, failing environment) → `W_HOOK_FAILED` with
   `details: { hook: 'compaction.before', owner, phase: 'flush' }`, the `eh.flush` record carries
   `error`, and compaction continues. A thrown tool error inside the flush is a tool error result
   (status `error`), as in a turn. An abort of the **turn** aborts the flush and the compaction:
   no record, no marker (tool side effects that already happened stay).
10. **Mid-turn.** The flush runs between two steps of the running turn (the step barrier has
    completed; nothing streams). Flush tool calls are not streamed to the UI (tools may still
    write the transient `data-eh.status { state: 'tool' }`); flush steps do not count toward the
    turn's step count, `maxSteps`, progress guard or thrash window.

### 5.3 Summarize

1. Render `drop` as a **flat text transcript** (never raw tool messages — some providers continue
   the markup instead of summarizing). Entries are separated by a blank line:
   - the previous summary first, as `PREVIOUS SUMMARY:`,
   - user/assistant text as `USER:` / `ASSISTANT:` entries (consecutive text and file parts of a
     message form one entry),
   - tool calls as `TOOL <name>(<json input, truncated 500 chars>) → <output, truncated 2_000 chars>`;
     the output is the JSON output, `ERROR: <errorText>`, `DENIED[: <reason>]` or `(no result)`,
   - reasoning dropped, file parts as `[file <mediaType> <name>]`,
   - `data-eh.input` parts as `USER:` entries (source `event` / `plugin:*` as `EVENT:` / `NOTE:`),
     in place,
   - other data parts via their `model` projection (omitted ones dropped) with the message's role
     prefix; kinds via their projection as `EVENT:` entries (boundary markers never).
   Truncation uses the head + tail helper of spec 09 §4.
2. Hooks `compaction.prompt` add `context` lines (e.g. files in progress) or replace the prompt
   (`out.prompt` starts as `config.prompt`; the default prompt applies when it is empty).
   `out.messages` holds copies of the messages being summarized (read-only input, e.g. to carry
   state that lives in them across the compaction).
3. `generateText({ model, instructions: prompt, prompt: transcript + context, maxOutputTokens: maxSummaryTokens })`;
   the prompt wraps the transcript in `<transcript>…</transcript>` and lists the context lines
   after it. The summarizer window is `config.contextWindow` of `CompactionConfig`, else the agent
   window of the summarizer model.
4. If the transcript exceeds 60% of the summarizer `contextWindow`, summarize in sequential chunks
   (each at most 60% of the window minus `maxSummaryTokens` and the prompt; a single larger entry
   is truncated), feeding the running summary into the next chunk as `PREVIOUS SUMMARY:`
   (rolling). The context lines go with the last chunk.
5. **Usage and budgets** (0.4.0). Every summarizer call is charged — also one that then fails
   (e.g. a cut summary, §5.5): during a turn (pre-turn, mid-turn and overflow compaction) as
   nested turn usage, like `ctx.turn.addUsage(usage, { model: summarizer, source: 'compaction' })`
   — so it appears in `TurnResult.usage` (tokens and `costUsd`), the message's
   `metadata.eharness.usage`, `state.core.usage` and counts toward `budget` (spec 12 §4); a manual
   `compact()` adds it to `state.core.usage` directly (tokens and `costUsd`; `turns` unchanged).
   Budgets are checked **before** summarizing: when the turn or session budget is used up, the
   compaction is skipped (`W_BUDGET` with `details.compaction: true`; the guard keeps the request
   within the window; a manual `compact()` resolves `null`, only the session budget applies to
   it). When a turn's compaction itself uses up the budget, the turn stops with `'cost-cap'`
   before its next model call. With a budget configured, an unpriced summarizer raises
   `W_MODEL_UNPRICED`.

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

`save(marker)` goes through `message.beforeSave` like every save; a failing save is a failed
compaction (§5.5; manual: `EH_STORAGE`). A failing state write is logged and not fatal (the loader
heals the pointer).

Crash safety: if the process dies after the summary is generated but before `save(marker)`,
nothing changed — the next load compacts again. If it dies after `save` but before the state write,
the loader (spec 05 §5) finds the newer marker in the range and heals the pointer — with or without
a previous pointer.

### 5.5 Failure

Summarizer error, empty output, or a summary cut by the output limit (`finishReason: 'length'`
on any chunk: a truncated brief would silently lose the end of the work state, so it is not
used — no retry) → warning `W_COMPACTION_FAILED` (`details: { trigger, reason? }`, `reason:
'length' | 'empty'`), no marker, continue with the guard. Manual `compact()` rejects with
`EH_COMPACTION_FAILED` (same `details.reason`). Raise `maxSummaryTokens` when this happens.

## 6. Guard (always on, not configurable away)

Runs before every step, on the **UI view** (grouped into turns as in §5.1), then re-projects. For
the in-turn part of the wire (response messages appended by the loop), the loop records the wire
index where the current turn starts.

The wire of a turn is built from the view (at turn start and after every compaction): the
boundary's projection (head), one segment per completed turn (projected per turn, then pruned
when `prune` is on, §5.0), then the current turn. `select` (§1) is applied to the view here, so
it changes the wire only. Sanitize
(step 1) runs before `step.prepare` (hooks see the sanitized wire); the hard cap (step 2) runs
after it, for the step's model and settings (`maxOutputTokens`), and counts the step reminder.
A `step.prepare` `messages` rewrite is treated as the current turn (no droppable turns).

1. **Sanitize** (ADR-0014):
   - a tool call without a result gets a synthesized error result
     (`{ type: 'error-text', value: INTERRUPTED_UNKNOWN }`, spec 10 §5) instead of being removed —
     the model learns the call did not complete instead of silently losing it; the only
     exceptions are the calls whose `tool-approval-response` ends the wire of a `respond()`
     continuation's first step (AI SDK executes those); a result that shares the final tool
     message with its approved response (an automatic approval) is kept, so the call is never
     executed again;
   - a tool result without a call is removed;
   - empty messages are removed.
2. **Hard cap:** limit = `window × maxContextRatio − reserveTokens`. While over the limit:
   1. drop the oldest whole completed turn after the boundary (warning `W_CONTEXT_TRUNCATED`);
   2. when only the current turn remains, truncate the largest tool outputs in the wire copy (not
      in storage) with the `TOOL_OUTPUT_TRUNCATED` helper (spec 09 §4): the largest output above
      1_000 characters is halved (head + tail; JSON outputs become
      `{ truncated: true, preview, originalChars }`) until the request fits. JSON outputs are
      measured **serialized** (escapes count): the preview keeps as many characters as fit the
      halved size once serialized, so an escape-heavy preview (`"`, `\`) still shrinks;
   3. if still over → end the turn with `stop: 'error'`, error code `EH_CONTEXT_OVERFLOW`.

The guard only changes the wire, never stored messages. Truncation uses the same head + tail
helper as tool output limits (spec 09 §4). `W_CONTEXT_TRUNCATED` is raised at most once per turn.

## 7. Overflow recovery

Token estimates can be wrong (images, provider tokenizers). When the provider rejects a request
because the context is too long, the core recovers instead of failing the turn:

1. **Detect.** The core's `onError` for `toUIMessageStream` records the raw error of the step.
   An `error` chunk that arrives **before the step's first `start-step`** (the provider call
   failed before streaming) is held back until the core has decided. The error is an overflow
   when, walking its chain, some error has HTTP status 400 or 413 **and** a message or provider
   payload matching the built-in patterns (`prompt is too long`, `context_length_exceeded`,
   `maximum context length`, `too many tokens`, …; list in `src/compaction/overflow.ts`), or when
   `config.isContextOverflow?(error)` returns true. Recognised error shapes (shared with
   `describeError`, spec 10 §3; `src/internal/provider-errors.ts`):

   | Shape | Status | Texts matched |
   |---|---|---|
   | AI SDK `RetryError` (any `reason`, e.g. `errorNotRetryable` after a 429 then a 400) | — | unwrapped: `lastError` with its whole `.cause` chain, then the other `errors`, most recent first |
   | AI SDK `APICallError` | `statusCode` | `message`, `responseBody`, `data` |
   | AI SDK `StreamProviderError` | `statusCode` (none → never an overflow) | `message`, `data`, `code`, `type` |
   | anything else (gateway, fetch, wrappers) | `statusCode` or `status` (integer) | `message`, `responseBody`, `body`, `data`, `error` |

   `.cause` is followed for every error (depth first: an error, the errors it wraps, then its
   causes; cycle-safe, at most 8 errors).
2. **Recalibrate.** If the provider reports the actual token count, set `k = actual / estimate`
   (the clamp of §2 no longer applies for this session); otherwise `k = k × 1.25`.
3. **Compact and retry once per turn** (`W_OVERFLOW_RETRY`): run a mid-turn compaction (pre-turn
   rules if no step completed yet) ignoring `summarizeAt` but keeping the skip rule, then retry the
   same step. The held-back error chunk is discarded.
4. **Tighter guard.** If the retry overflows again (or compaction was skipped or disabled), run
   the guard with `maxContextRatio × 0.8` and retry once more (`W_OVERFLOW_RETRY` again). The
   tighter ratio stays for the rest of the turn.
5. **Give up.** Forward the error, end the turn with `stop: 'error'` and `EH_CONTEXT_OVERFLOW`.

Overflow errors that arrive after streaming started are not retried (the partial output has
already been delivered).

## 8. What compaction never does

- Delete or rewrite stored messages (history stays complete for UIs and audits). The prune stage
  (§5.0) changes the request only, never storage.
- Summarize messages hidden by a rewind.
- Run while another compaction for the same session is running.
- Change the instructions or the tool set.
- Leave a pre-compaction flush in the model's context (§5.2a: only its `eh.flush` audit record is
  stored, and it is never projected).
