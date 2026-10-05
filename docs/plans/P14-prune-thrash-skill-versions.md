# P14 — Context pruning, thrash detection, skill versions

Status: done · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal items **U2** (prune stage), **U8** (compaction thrash detection) and
**U7** (skill versions).

## Goal

Old, large tool outputs can be replaced by short placeholders in what the model sees — cheaper
than summarizing and friendly to the prompt cache — before the summarizer runs. A turn whose
context fills up again right after a compaction stops with a clear stop reason instead of
summarizing over and over. Skills carry an optional `version` that is shown to the model and
passed to hooks, so applications with versioned skills can audit which version a turn used.
Without new configuration, 0.3.x behaviour is unchanged.

## Specs / docs to read

- `docs/specs/06-compaction.md` §1 (config), §2 (token accounting), §4 (triggers, skip rule),
  §5.1 (turn grouping, split), §5.3 (transcript), §6 (guard, wire built per turn), §7 (overflow)
- `docs/specs/03-messages.md` §6 (projection to the model)
- `docs/specs/02-context-registry.md` §5–§6 (prompt layout, caching rules)
- `docs/specs/10-errors-and-stop-reasons.md` §2 (warnings), §4 (stop reasons)
- `docs/specs/05-session-and-storage.md` §3.1 (stop rules)
- `docs/specs/07-skills.md` §3 (`SkillMeta`), §4.3 (`load_skill` format), §8 (frontmatter)
- `docs/specs/01-agent-and-plugins.md` §5 (`skill.load` hook)
- ADR-0004 (fixed compaction), ADR-0013 (cache-friendly layout), ADR-0015 (progress-bounded loop)
- `docs/plans/P9-progress-loop.md` open question on compaction thrashing

**AI SDK verified (2026-10-05):** `ToolResultPart` is exported from `ai` (re-export of
`@ai-sdk/provider-utils` `ToolResultPart`, installed `ai@7.0.123` `dist/index.d.ts` export list);
its `output` is the `ToolResultOutput` union (`text` / `json` / `error-text` / `error-json` /
`execution-denied` / `content`). `replaceWith` uses this type directly (ADR-0001), no parallel
shape.

## Owns

`src/compaction/**` (new `prune.ts`), `src/messages/project.ts` (prune hook point),
`src/loop/steps.ts` / `src/loop/stop.ts` (thrash stop), `src/skills/**` (version),
`src/messages/types.ts` (`StopReason`), `src/errors.ts` (warning code), specs 06 / 07 / 10 /
03, new ADR-0019, `docs/guides/compaction.md`, `docs/guides/skills.md`, `examples/`.

## Scope

- In: `compaction.prune`, thrash detection with stop `'context-thrash'`, `SkillMeta.version`.
- Out: pruning inside the **current** turn (open question), LLM-chosen pruning, storage rewrites.

## Design

### Prune (U2)

```ts
import type { ToolResultPart } from 'ai'

export interface CompactionConfig {
  // … existing fields
  prune?: PruneConfig | false          // default: off (undefined = off; `{}` = on with defaults)
  thrash?: { withinSteps?: number } | false   // default { withinSteps: 2 } (see below)
}
export interface PruneConfig {
  /** Completed turns (newest first) whose tool outputs are never pruned. Default 2. The current turn is never pruned. */
  keepTurns?: number
  /** Only outputs whose projected size exceeds this many characters are pruned. Default 2_000. */
  minChars?: number
  /** Final tool names never pruned. */
  exclude?: string[]
  /** Placeholder text. Default: TOOL_OUTPUT_PRUNED (`[output of <tool> pruned: <n> chars]`). */
  replaceWith?: (part: ToolResultPart) => string
}
```

Normative rules (spec 06 new §5.0 "Prune"):

1. **View-only.** Prune runs in projection when the wire is built from the view (turn start,
   after a compaction, spec 06 §6). Stored messages, `metadata.eharness.tokens` and UI history are
   never changed.
2. **Deterministic.** Whether an output is pruned depends only on (its turn's distance from the
   current turn, its size, its tool name). Same view → same wire, byte for byte. `replaceWith` must
   be pure; its result is used as a `{ type: 'text', value }` output (errors and
   `execution-denied` results are never pruned — they are short and carry meaning).
3. **Pairs stay intact.** Only the `output` of a `tool-result` part is replaced; the `tool-call`
   and the result part stay (ids, names, inputs unchanged). Tool inputs are not pruned.
4. **Order per check:** prune → recompute the estimate → summarize only if still above
   `summarizeAt` (pre-turn and mid-turn triggers, and the skip rule's estimate, use the pruned
   size). The guard (§6) runs after, unchanged.
5. **Cache cost (documented):** the wire is rebuilt at turn start, so when `keepTurns` slides one
   turn further, the prefix changes **once per turn** at the oldest newly-pruned output; inside a
   turn the prefix is stable. Mid-turn prune does nothing new (only completed turns are pruned and
   they do not change within a turn).
6. **Summarizer transcript:** uses the original outputs (already capped at 2 000 chars by §5.3),
   not the placeholders — the summary is where information is condensed (decision, see open
   questions).
7. **Accounting:** the pruned saving is computed per message at projection (cached per message
   id + prune parameters for the session), so `ContextStats.messages` reflects the pruned wire;
   `ContextStats` gains `pruned?: { outputs: number; chars: number }`.

### Thrash detection (U8)

- After an automatic compaction (mid-turn, pre-turn or overflow) the core remembers the step
  index. If the context is above `summarizeAt` again (after prune) within `thrash.withinSteps`
  (default 2) model steps, the core does **not** compact again: it raises `W_CONTEXT_THRASH`
  (`details: { stepIndex, tokens, summarizeAt, lastCompaction }`) and stops the turn with the new
  stop reason **`'context-thrash'`** after the current step (no further model call; the guard
  still protects the step already decided).
- `turn.beforeEnd` does not run for `'context-thrash'`; dangling calls answered as usual; an
  `eh.notice` (level `warning`, code `EH_CONTEXT_THRASH`) is saved so UIs see why.
- `thrash: false` restores 0.3 behaviour (compact again; the "failed compaction not retried in
  the same turn" rule of §4 stays).

### Skill versions (U7)

- `SkillMeta.version?: string` (and therefore `SkillDoc`, `Skill`); read from frontmatter
  `version:` by `parseSkillMarkdown` (always a string, `1.0` stays `"1.0"` — relies on P13
  item 15), validated 1–64 printable chars.
- `load_skill` output: `version: <v>` line right after `description` in the frontmatter summary
  (model-visible format change, documented in spec 07 §4.3 + golden).
- `skill.load` hook event gains `version?: string` (copied from the doc), `SkillMeta.version` in
  the skills index is **not** shown (index stays cache-stable when only versions change).
- `skillSourceConformance` fixture gains a skill with `version`.

## Checklist

- [x] ADR-0019 "Prune stage and thrash stop" (`Proposed` → `Accepted` on merge): amends ADR-0004
      — compaction stays one fixed algorithm; prune is a **setting** of it, not a strategy. Mark
      ADR-0004 "Amended by ADR-0019".
- [x] Spec 06: §1 config, new §5.0 Prune, §2 `ContextStats.pruned`, §4 order note + thrash rule,
      §8 "never" list (prune never touches storage); spec 10: stop reason, `W_CONTEXT_THRASH`,
      `EH_CONTEXT_THRASH` notice code, `TOOL_OUTPUT_PRUNED` text; spec 03 §6 projection step;
      spec 07 version.
- [x] Tests first (`src/compaction/prune.test.ts`):
  - [x] deterministic: same view projected twice → identical wire; independent of wall clock;
  - [x] cache-stable: within a turn of 10 steps the wire prefix up to the current turn is
        byte-identical across steps; across turns only the newly aged turn changes;
  - [x] `exclude`, `minChars`, `keepTurns` honoured; errors/denied never pruned; current turn
        never pruned;
  - [x] pairs intact: every `tool-call` keeps its `tool-result` (sanitize finds nothing to fix);
  - [x] storage untouched (adapter spy sees no extra save);
  - [x] summarize not triggered when prune alone brings the context under `summarizeAt`;
        triggered when it does not;
  - [x] `replaceWith` receives the AI SDK `ToolResultPart` and its text is used;
  - [x] `prune` undefined → wire identical to 0.3 golden.
- [x] Implement `src/compaction/prune.ts` + projection hook point + estimate integration.
- [x] Thrash tests (`compaction.int.test.ts`): context refills within 2 steps → `'context-thrash'`,
      `W_CONTEXT_THRASH`, notice saved, no second summarizer call; refill after 3 steps → normal
      second compaction; `thrash: false` → second compaction.
- [x] Implement thrash detection in the loop (stop rule placed with the mid-turn trigger).
- [x] Skill version tests (frontmatter, `load_skill` golden, hook event, conformance fixture);
      implement.
- [x] Guides: `compaction.md` (prune section, cache trade-off, thrash), `skills.md` (version);
      offline example `examples/context-prune.ts` (scripted model, large tool outputs) added to
      `examples/examples.test.ts`.
- [x] `reference.md` rows (prune options, stop reason, warning).
- [x] Changeset; board updated.

## Acceptance criteria

- [x] With `prune: {}` a 20-turn tool-heavy scripted session reaches the summarizer later (or
      never) compared with `prune` off, and the stored messages are byte-identical in both runs.
- [x] No tool call/result pair is ever split by prune (property test over random views).
- [x] A thrashing turn stops with `'context-thrash'` after at most one compaction.
- [x] `load_skill` shows `version:` when present; nothing changes for skills without it.
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New `compaction.prune` (off by default) — view-only pruning of old tool outputs before
  summarizing.
- New stop reason **`'context-thrash'`** and warning `W_CONTEXT_THRASH`; `compaction.thrash`
  option (default on, `withinSteps: 2`) — **behaviour change**: a turn that refills its context
  within 2 steps after a compaction now stops instead of compacting again; set `thrash: false`
  for 0.3 behaviour.
- **Type-level:** `StopReason` gains `'context-thrash'`; exhaustive `switch` statements over
  `StopReason` must add a case (same note as `'stuck'` in 0.3).
- `SkillMeta.version`; `load_skill` output shows `version:` (model-visible format addition);
  `skill.load` event gains `version`.

## Open questions

- Prune default: **off** (proposal: "without new configuration, 0.3.x behaviour is unchanged").
  Decision made.
- Summarizer transcript sees original (2 000-char capped) outputs, not placeholders — deviation
  from the proposal's "(and the summarizer transcript)"; recorded for the BTeams results table
  (P20). Revisit if summarizer cost matters more than summary quality.
- Pruning older steps **inside** a long current turn (opencode prunes by token distance, not by
  turn): out of scope; it would change the prefix every step. Roadmap candidate.
- Thrash default on is a behaviour change in a minor (allowed in 0.x); conservative alternative is
  default off. Decision: on, because repeated compaction in one turn burns money without progress
  (same reasoning as the progress guard, ADR-0015). Changeset calls it out.

- **Implementation notes (P14).** (a) The prune hook point is the turn wire builder
  (`src/compaction/turn-context.ts` `build()`, per completed-turn segment), not `project()`:
  `project()` also feeds token estimates and the summarizer transcript, which must stay unpruned;
  spec 03 §6 documents the step. `src/messages/project.ts` is unchanged. (b) Unit tests live in
  `src/compaction/prune.test.ts`, turn-level ones (cache stability, storage, summarize trigger,
  0.3 golden `prune-off.prompts.json`, stats) in `src/compaction/prune.int.test.ts`.
  (c) Provider-executed tool results (inside assistant messages) are never pruned — their format
  is provider-specific (conservative). (d) A throwing / non-string `replaceWith` falls back to the
  default placeholder silently (it must be pure; no warning to avoid noise every turn).
  (e) `ContextStats.pruned.chars` = characters saved (original − placeholder).
  (f) `W_CONTEXT_THRASH.details.lastCompaction` = the step index of that compaction (pre-turn = 0).
  (g) The thrash check runs at the mid-turn trigger, after input of the step boundary was
  delivered (same place as the budget `cost-cap` stop after a compaction); that input is stored but
  never seen by the model — acceptable, same as `cost-cap`. (h) The notice is saved in
  `src/session/turn.ts` (`onEnd`, next to the error/timeout notice) — a 10-line edit outside the
  owned folders. (i) An invalid frontmatter `version` makes the skill invalid
  (`W_INVALID_SKILL` / `EH_CONFIG_INVALID`) instead of silently moving it to `meta`; before 0.4 a
  `version` key landed in `meta` (shown by `load_skill` in the same place, now quoted when it looks
  like a number). `skillSourceConformance` checks `version` by default (opt out `{ version: false }`).

## Requests to other phases

- P15: the flush runs **after** prune decided summarizing is still needed (prune → flush →
  summarize). P15 must use the post-prune decision.
- P20: production guide mentions prune for tool-heavy agents; results table U2/U7/U8.

## Dependencies

P13 recommended first (shares `src/compaction/guard.ts`, `truncate.ts`). No hard dependency.
