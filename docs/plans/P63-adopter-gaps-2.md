# P63 — Adopter gaps 2: flush failure policy, cache-stable turn reminder

Status: review (2026-11-13; awaiting push and release) · Owner: Riz · Branch: `main` (no phase branch, like P62)

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
| D | The app's `webSearch` `search` function gets no session context, so its own paid call cannot be attributed, limited or keyed per person or tenant | accepted (feature) | Any search function that does its own model or API call needs the asking person for audit logs, quotas or per-tenant keys. `webFetch` already passes `ctx` to its policy functions; `SearchOptions.ctx` follows that convention. `webFetch` needs no counterpart (its other callbacks are transforms and transport). |
| C | Provider-executed tool calls (for example a provider web search) carry no principal | skipped (no library gap) | eharness never executes such calls, so `tool.before`/`tool.after` do not fire for them, but `step.end` lists them in `toolCalls`/`toolResults` (`event.step` keeps `providerExecuted: true`) and its `ctx.principal` is the turn principal, as in every hook. Per-call logs read them there. |

## Specs

- `docs/specs/06-compaction.md` §5.2a rule 9a, §5.5 (A)
- `docs/specs/01-agent-and-plugins.md` §5 `CompactionBeforePatch` (A)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (A)
- `docs/specs/02-context-registry.md` §5, §6 rule 2a, `docs/specs/01-agent-and-plugins.md` §1, §7, ADR-0073 (B)

## Owns

- `src/compaction/flush.ts`, `src/compaction/compact.ts`, `src/plugin/types.ts` (A)
- `src/loop/prompt.ts`, `src/loop/step-build.ts`, `src/agent/types/agent.ts`, `src/agent/define-agent.ts` (B)
- The specs above, changesets, this file and the board row

## Checklist

- [x] A: `flush.onFailure`, merge rule, abort for pre-turn, mid-turn and manual, ignored on overflow; tests in `src/compaction/flush.int.test.ts`; changeset
- [x] B: `reminders.turnPlacement: 'end'` (ADR-0073); `src/loop/reminder-placement.int.test.ts` proves turn N+1's request starts with the bytes of turn N's stable prefix (and that the default does not); changeset
- [x] D: `SearchOptions.ctx` (spec 22 §3); test in `src/web/web.test.ts`; changeset
- [x] C: verified with a probe (`step.end` carries the provider-executed call and `ctx.principal`); no change

## Evidence for B

Measured with the scripted model: an 8 000 character system prompt, a 3 000 character turn
reminder (about 750 tokens), one 20 000 character tool result per turn. Characters of the first
request of a turn that are not a prefix of the previous request:

| Turn | Default `'turn-start'` | `'end'` |
|---|---|---|
| 2 (request 32 151 chars) | 24 070 | 3 807 |
| 3 (request 52 515 chars) | 23 472 | 3 209 |

## Acceptance criteria

- [x] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green (A and B: 6956 pass, 0 fail)
- [x] Changesets added; specs updated

## Open questions

- The memory plugin's `flushOnCompaction` could expose `onFailure` too. Left out: the hook patch is
  public, and an app can wrap the hook today. Revisit when a second adopter asks.
