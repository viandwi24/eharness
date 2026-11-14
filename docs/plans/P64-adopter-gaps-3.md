# P64 — Adopter gaps 3: routed Anthropic caching, flush without a summary, plugin test helper

Status: done (released in 0.14.0; one fix in 0.14.1) · Owner: Riz · Branch: `main` (no phase branch, like P63)

## Goal

A second triage of gaps reported by an application built on eharness 0.13.0, judged by the rule
"change the library only for real bugs or for features any adopter can reuse". Every accepted
change is opt-in or additive; defaults keep 0.13.0 behaviour. The aim is one release that holds
every accepted gap of this round, not several small ones.

## Triage

| # | Candidate | Verdict | Why |
|---|---|---|---|
| A | Anthropic models reached through a router (provider id not `anthropic`) never get cache markers | accepted (feature) | Any app that reaches Claude through a router pays full input price on every step. The router's AI SDK provider forwards `providerOptions.anthropic.cacheControl` per message; only the detection is missing. Opt-in predicate `cache.include`. |
| B | Saving facts from a session without summarizing it | accepted (feature) | An app that ends or archives a conversation wants the flush but has no use for a summary; `compact({ keepLast: 0 })` pays one summarizer call nobody reads. `session.flush()` runs the flush stage alone. |
| C | No public way to unit-test a plugin's tools and hooks | accepted (feature) | Apps read the private `'~def'` field and call `setup` by hand. `resolvePlugin` in `eharness/testing` resolves a plugin the way a session does. |
| D | `definePlugin` results needed casts to fit `HarnessPlugin` and the `plugins` options | no library gap | A type test shows they assign without casts in 0.13.0; the casts were left over from older versions. The type test is kept to pin it. |
| E | A read-only budget status per scope | no library gap | `BudgetLedger.check(scopes)` already returns limit, spent and reserved per scope. |
| F | Deleting a session's stored data | deferred | Needs a delete operation on every storage port and adapter; no adopter needs it for this release (an app can drop an in-memory agent). Revisit with a concrete need. |

## Specs

- `docs/specs/02-context-registry.md` §6.1, `docs/specs/01-agent-and-plugins.md` (A)
- `docs/specs/06-compaction.md` §4, §5.2a rule 11, `docs/specs/05-session-and-storage.md` §2, `docs/specs/01-agent-and-plugins.md` §5 (B)
- `docs/engineering/testing.md` "Testing a plugin", `docs/specs/01-agent-and-plugins.md` §2 (C)

## Checklist

- [x] A: `cache.include`; tests in `src/loop/loop.test.ts`; wire checked against the router provider (markers on system block 1 and the last stable message; the tool marker is dropped by that provider); changeset
- [x] B: `session.flush()` → `SessionFlushResult`, `CompactionBeforeEvent.flushOnly`; `src/compaction/flush-only.int.test.ts`; changeset
- [x] C: `resolvePlugin`, `fakeHarnessContext`; `src/testing/plugin-resolve.test.ts`; changeset
- [x] D: `src/plugin/define-plugin.test-d.ts`; no change
- [x] Adopter check: the reporting application ran its full test gate and smoke run against a local build

## Acceptance criteria

- [x] `bun run lint && bun run typecheck && bun run check:exports && bun run check:imports && bun run check:throws && bun run test:fast` green (2478 pass, 0 fail), plus `bun test ./src/session` (773 pass) and `./src/compaction` (132 pass)
- [x] Changesets added; specs updated

## Fix after release (0.14.1)

`session.flush()` planned with `compaction.keepLast` instead of `keepLast: 0`, against rule 11: a
session with no more completed turns than `keepLast` flushed nothing. Found by an adopter test that
flushed after a single turn; the tests of this phase all used `keepLast: 1` with longer histories.
Test: "covers every completed turn whatever compaction.keepLast says" in
`src/compaction/flush-only.int.test.ts`.
