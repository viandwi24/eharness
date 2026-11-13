# P63 — Adopter gaps 2: flush failure policy, cache-stable turn reminder

Status: in progress · Owner: Riz · Branch: `main` (no phase branch, like P62)

## Goal

Three candidate gaps reported by an application built on eharness 0.12.0 were judged against the
rule "change the library only for real bugs or for features any adopter can reuse". After this
phase a flush that saves facts before a summary can veto the summary when the save did not happen,
and the turn reminder can be placed so the whole previous turn stays in the provider's cached
prefix. Every change is opt-in; defaults keep 0.12.0 behaviour.

## Triage

| # | Candidate | Verdict | Why |
|---|---|---|---|
| A | Compaction summarizes even when the pre-compaction flush failed | accepted (feature) | Any app that uses the flush to persist facts (the memory plugin's `flushOnCompaction` pattern) loses them when the summary runs after a failed save. Generic, opt-in. |
| B | Per-turn reminder appears to defeat provider prefix caching | accepted (bug in the cache layout, opt-in fix) | The turn reminder sits before the current turn's first message and is not re-sent in later turns, so from the next turn on the prefix diverges where that reminder was: the whole previous turn (its user message, tool calls and results) is billed as uncached input once more. This holds for every adopter that has turn-refresh instructions or page context. |
| C | Provider-executed tool calls (for example a provider web search) carry no principal | skipped (no library gap) | eharness never executes such calls, so `tool.before`/`tool.after` do not fire for them, but `step.end` lists them in `toolCalls`/`toolResults` (`event.step` keeps `providerExecuted: true`) and its `ctx.principal` is the turn principal, as in every hook. Per-call logs read them there. |

## Specs

- `docs/specs/06-compaction.md` §5.2a rule 9a, §5.5 (A)
- `docs/specs/01-agent-and-plugins.md` §5 `CompactionBeforePatch` (A)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (A)
- `docs/specs/02-context-registry.md` §5, §6 (B)

## Owns

- `src/compaction/flush.ts`, `src/compaction/compact.ts`, `src/plugin/types.ts` (A)
- `src/loop/prompt.ts`, `src/loop/step-build.ts`, agent config types (B)
- The specs above, changesets, this file and the board row

## Checklist

- [x] A: `flush.onFailure`, merge rule, abort for pre-turn, mid-turn and manual, ignored on overflow; tests in `src/compaction/flush.int.test.ts`; changeset
- [ ] B: opt-in turn reminder placement; test that turn N+1's request starts with turn N's stable prefix; changeset
- [x] C: verified with a probe (`step.end` carries the provider-executed call and `ctx.principal`); no change

## Acceptance criteria

- [ ] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green
- [x] Changesets added; specs updated

## Open questions

- The memory plugin's `flushOnCompaction` could expose `onFailure` too. Left out: the hook patch is
  public, and an app can wrap the hook today. Revisit when a second adopter asks.
