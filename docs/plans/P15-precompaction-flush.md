# P15 — Pre-compaction flush

Status: in progress · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal item **U1**.

## Goal

Before history is summarized (lossy), plugins can give the agent one bounded, internal chance to
save important facts — typically into memory files (P17) — through a new `compaction.before` hook
and a **flush turn**. The flush leaves no conversational trace the model sees later, but it is
recorded as a model-invisible kind message (`eh.flush`) so audits can see that it ran, what tools
it called and what it cost. Its usage is charged to the turn and budgets.

## Specs / docs to read

- `docs/specs/06-compaction.md` §4 (triggers, skip rule), §5.1 (split: `drop` / `keep`),
  §5.3 (summarize), §5.4 (commit), §5.5 (failure), §7 (overflow recovery)
- `docs/specs/01-agent-and-plugins.md` §5 (hooks, chaining, failure policy)
- `docs/specs/03-messages.md` §5 (kinds; new core kind `eh.flush`)
- `docs/specs/11-interaction.md` §3 (approval; flush auto-denies)
- `docs/specs/12-models-and-cost.md` §3–§4 (`addUsage`, budgets)
- `docs/specs/02-context-registry.md` §5–§6 (the flush must not disturb the main wire/cache)
- ADR-0004, ADR-0005 (markers as messages), ADR-0013, ADR-0012
- `docs/plans/P13-hardening.md` item 19 (summarizer usage accounting — reused here)
- `docs/plans/P14-prune-thrash-skill-versions.md` (prune runs first)

**AI SDK verified (2026-10-05):** the flush uses `generateText` with `tools`, `activeTools`,
`stopWhen: isStepCount(n)` (exported as `stepCountIs`), `toolApproval` (v7 approval config,
never `needsApproval`) and `instructions` (not `system`) — all present in installed
`ai@7.0.123` `dist/index.d.ts` and unchanged through 7.0.127
(`https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md`). Usage comes from
`result.totalUsage`.

## Owns

`src/compaction/**` (new `flush.ts`), `src/plugin/types.ts` (hook), `src/messages/kinds.ts`
(core kind), `src/session/turn.ts` / `src/loop/steps.ts` (call site), specs 01 / 03 / 06 / 10,
new ADR-0020, `docs/guides/compaction.md`, `examples/compaction-flush.ts`.

## Design

```ts
'compaction.before'?(
  ctx: HarnessContext<DP>,
  e: {
    /** The part that will be summarized (`drop`, spec 06 §5.1), view messages, not the kept tail. */
    messages: HarnessUIMessage[]
    /** Calibrated estimate of the current context. */
    tokens: number
    trigger: 'auto' | 'manual' | 'turn' | 'overflow'
  },
): Awaitable<void | CompactionBeforePatch>

export interface CompactionBeforePatch {
  flush?: {
    prompt: string
    /** Final tool names the flush may call. Default: none (text-only flush is allowed but useless). */
    tools?: string[]
    /** Default 3. */
    maxSteps?: number
    /** Default: compaction.model ?? the turn's model. */
    model?: LanguageModel
  }
}
```

Rules (spec 06 new §5.2a "Flush"):

1. **When.** Once per compaction, after the split and skip rule decided that summarizing will
   happen (and after prune, P14), before the summarizer. `trigger` mirrors the compaction trigger
   (`'turn'` = pre-turn, `'auto'` = mid-turn, `'manual'`, `'overflow'`).
2. **Chaining.** Hooks run in plugin order; patches merge: prompts joined with a blank line, tool
   lists unioned (order: first appearance), `maxSteps` = max, `model` = last non-undefined.
   A hook that throws → `W_HOOK_FAILED`, skipped.
3. **Run.** `generateText` with: instructions = the agent's block 1 + block 2 (stable prefix),
   messages = the **current wire** (pre-compaction, after guard sanitize) + a user message with
   the merged prompt; tools = the turn's tools filtered to the whitelist (same wrapped tools, so
   `tool.before` / `tool.after` / output limits apply); `stopWhen: stepCountIs(maxSteps)`.
4. **Approval.** Every tool call that would need approval (`user-approval` from policy, risk or
   `tool.approve`) is **auto-denied** with reason `Not available during memory flush.`; client
   tools (no `execute`) are never in the flush tool set. `approval.decided` fires with
   `by: 'policy'` for those denials.
5. **Overflow.** For `trigger: 'overflow'` the flush is skipped unless `flush.model` resolves to a
   window larger than the current context estimate + `maxOutputTokens`; same check for any trigger
   (a flush that cannot fit is skipped with `W_COMPACTION_FLUSH_SKIPPED`, `details.reason:
   'window'`).
6. **No visible trace in the conversation.** Flush messages are never saved to history, never
   added to the wire of the turn, never projected. Effects exist only through tool side effects.
7. **Audit record.** After the flush, the core saves a core kind message **`eh.flush`** (role
   `assistant`, `model: 'omit'`, not a boundary) with payload
   `{ trigger, prompt, model?, steps, toolCalls: Array<{ toolName, status: 'output' | 'error' |
   'denied' }>, usage, costUsd?, error? }` (no tool inputs/outputs — they may be large or
   sensitive; apps that want them use `tool.after`). It is saved before the compaction marker, so
   the marker stays the newest message (id order). Mid-turn: the kind message has an id greater
   than the running assistant message and belongs to the next turn per spec 03 §5.4 (it is
   omitted from projection anyway). Its `turnId` is the running turn's id (manual: none).
8. **Accounting.** Flush usage goes through the P13 item 19 path: `addUsage(totalUsage, { model,
   source: 'compaction-flush' })` for turn-scoped compaction, `state.core.usage` for manual. A
   used-up budget skips the flush (`W_COMPACTION_FLUSH_SKIPPED`, `reason: 'budget'`).
9. **Failure.** A flush error (provider, tool crash, abort of the flush only) → `W_HOOK_FAILED`
   (`details: { hook: 'compaction.before', phase: 'flush' }`), the `eh.flush` record carries
   `error`, and compaction continues. An abort of the **turn** aborts the flush and the
   compaction as today.
10. **Mid-turn compaction.** Allowed: the flush runs between two steps of the running turn (the
    step barrier has completed, nothing streams). It writes `data-eh.status { state: 'compacting'
    }` as today; flush tool calls are **not** streamed to the UI (no chunks), only a transient
    `data-eh.flush` status part `{ state: 'running' | 'done', toolCalls: n }`. The running turn's
    progress guard, step count and `maxSteps` do not count flush steps.
11. **Streams/UI outside a turn (manual `compact()`):** the `eh.flush` message is delivered as a
    session `message` event like the marker.

## Checklist

- [x] ADR-0020 "Pre-compaction flush": why a separate internal call (not a visible turn), why an
      audit kind message instead of no trace, why auto-deny approvals, why flush is skipped on
      overflow.
- [x] Spec 01 §5 hook + `CompactionBeforePatch`; spec 03 §5.3 core kind `eh.flush` + data part;
      spec 06 §5.2a; spec 10: `W_COMPACTION_FLUSH_SKIPPED`; spec 12: `source: 'compaction-flush'`.
- [x] Tests first (`src/compaction/flush.int.test.ts`, scripted models for agent and flush):
  - [x] hook receives exactly the `drop` messages, `tokens`, correct `trigger` for pre-turn,
        mid-turn, manual;
  - [x] patches of two plugins merge (prompt, tools, maxSteps, model);
  - [x] a tool outside the whitelist is not offered (not in the flush call's tools); a
        whitelisted tool that needs approval is auto-denied and the denial reaches
        `approval.decided`;
  - [x] flush error → `W_HOOK_FAILED`, compaction still commits a marker;
  - [x] usage of the flush is in `TurnResult.usage` / `costUsd`; budget used up → flush skipped;
  - [x] overflow trigger → skipped unless `flush.model` has a larger window;
  - [x] nothing from the flush appears in later model wires (golden wire unchanged vs no flush,
        except the effects of tool side effects), stored history contains exactly one extra
        `eh.flush` message, ordered before the marker;
  - [x] mid-turn flush does not change the running turn's step count or progress window;
  - [x] abort during flush aborts the turn cleanly (no marker, dangling calls answered).
- [x] Implement `src/compaction/flush.ts` and call sites (pre-turn, mid-turn, overflow, manual).
- [x] Guide `compaction.md` section "Saving facts before summarizing" (with P17 memory tools as
      the main example, plus a plain custom tool); offline example
      `examples/compaction-flush.ts` in `examples.test.ts`.
- [x] `reference.md` rows; changeset; board.

## Acceptance criteria

- [x] A flush with a whitelisted `save_fact` tool writes the fact before the summary is produced
      (assert call order with a spy), and the next turn's wire contains only the summary — no
      flush messages.
- [x] The stored `eh.flush` record is valid against its schema and omitted from projection.
- [x] Budgets and `TurnResult.usage` include flush usage.
- [x] No hook → identical behaviour and storage to 0.3 (golden).
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New hook `compaction.before` with optional `flush` (internal pre-compaction turn).
- New core kind `eh.flush` (persisted, model-invisible audit record) and data part
  `data-eh.flush` (transient status); new warning `W_COMPACTION_FLUSH_SKIPPED`; usage source
  `compaction-flush`.
- Type-level: `HarnessHooks` gains a key; `HarnessKindTypes` gains `'eh.flush'` (UIs with
  exhaustive switches over core kinds must add a case).

## Open questions

Implementation decisions (P15, recorded for review):

- **Transient `data-eh.flush` shape.** The kind `eh.flush` registers `data-eh.flush` as a
  persistent data part with the `FlushPayload` schema, so a transient part of the same name with
  a different shape (`{ state, toolCalls }`) would contradict its type. Decision (follows the
  `data-eh.compaction` precedent): the transient `data-eh.flush` chunk carries the record's
  payload and is written once when the flush ends; "running" is covered by the existing
  `data-eh.status { state: 'compacting' }`.
- **Budget order / `reason: 'budget'`.** The existing compaction budget check (spec 06 §5.3)
  runs before the flush, so a used-up budget skips the compaction and the hook/flush together;
  `W_COMPACTION_FLUSH_SKIPPED` therefore only has `reason: 'window'`. After the flush the budget
  is checked again; a flush that used it up skips the summarizer (`W_BUDGET`, compaction skipped).
- **Turn abort during the flush.** No `eh.flush` record is stored (and no marker); tool side
  effects that already happened stay. A flush-only failure stores the record with `error`.
- **Flush tool status chunks.** Wrapped tools still write the transient
  `data-eh.status { state: 'tool' }` during a mid-turn flush (no tool call chunks are written).
- **Memory flush tools** include `memory_view` (read-only, needed to update existing files with
  `memory_str_replace`); delete/rename are never offered. With the `tool` option the single
  `memory` tool is offered (commands not filtered).
- **`FLUSH_APPROVAL_DENIED`** is exported as a fixed text from `eharness` (minor change if
  reworded).
- **ADR number.** ADR-0020 (reserved for P15; 0021/0022 already exist).
- **Pre-existing failure (not P15):** `src/session/turn.int.test.ts` "scenario 1" golden chunk
  order (`data-eh.status:tool` vs `start-step`) fails on `main` (a4e300a) too in this
  environment; untouched.

- Proposal said "flush messages are not stored"; decision: store an `eh.flush` audit record
  (metadata only, no inputs/outputs) — the conversation the model sees is still unchanged.
  Recorded for the BTeams results table.
- Flush context: whole current wire vs only `drop`. Decision: whole wire (the model needs the
  recent tail to know what matters) — it costs one extra call over a cached prefix.
- Should a flush be allowed to call tools that need approval when an approver is online?
  Decision: no (auto-deny); revisit with "rule-based grants" (roadmap).

## Requests to other phases

- P13 item 19 must be done (usage path, `source`).
- P14: prune decides first; flush runs only when summarizing will happen.
- From P17 (deferred item): add the memory plugin's `flushOnCompaction` option on top of the new
  `compaction.before` hook (see spec 14 §9 and docs/guides/memory.md), with a test and a doc update.
- P17: memory guide shows `compaction.before` returning `{ flush: { prompt, tools:
  ['memory_create', 'memory_str_replace', 'memory_insert'] } }`; consider an option
  `memory({ flushOnCompaction: true | { prompt } })` that registers this hook (P17 decides).
- P20: production guide and results table (U1).

## Dependencies

P13 (item 19). P14 recommended first (shared call site in `src/compaction`).
