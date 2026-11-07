# ADR-0070: Grants can be scoped to the person who asked, and apply at once

Status: **Accepted** · Date: 2026-11-08 · Plan: [P62](../plans/P62-adopter-gaps.md) · Builds on: [ADR-0069](0069-turn-principal.md) · Amends: spec 11 §3.1

## Context

`respond({ approvals: [{ id, approved, remember: 'session' }] })` stores
`state.core.grants[key] = 'always' | 'never'`, where `key` is the tool name or a `tool.grantScope`
result (spec 11 §3.1). Three things follow that surprise adopters:

1. **The key never includes who.** In a shared session (a group chat, a workspace with several
   people) one person's "always allow" answers the next person's request for the same tool.
2. **The grant waits one step.** A grant recorded by a `respond()` applies only after the first step
   of its continuation, so the model's next call to the same tool in that step asks again. The reason
   is documented: AI SDK re-validates the calls just answered, and a grant must not change their
   outcome. The delay also hits every other call in the step.
3. **`permissions` session rules are engine-wide.** Rules added with `scope: 'session'` live in a
   `Set` inside the engine object (`engine.ts` `sessionRules`), so they apply in every session that
   shares the agent. This is a bug, not a policy.

Keith worked around (2) with its own per-session map in `motor/remote.ts`, and found (1) when two
people had to share one approval path.

## Decision

1. **`grants: { by: 'session' | 'principal' }`** on the agent (and session) options, default
   `'session'`, which is today's behavior.
   - With `'principal'`, the stored key is `<principal id>\u0000<tool key>` where `tool key` is the
     existing tool or `tool.grantScope` key. A call with no principal uses the session key.
   - A grant answered by person A never satisfies a request that carries principal B, and the other
     way round. `clearGrants()` takes an optional principal.
2. **`grants: { applyAt: 'continuation' | 'now' }`**, default `'continuation'` (today).
   - With `'now'`, a recorded grant applies at once to every call **except the call ids that the
     same `respond()` answered**. Those stay unaffected, which keeps the reason for the delay.
   - The default flips at 1.0, after one minor with the option and the notes in
     `docs/guides/upgrading.md`.
3. **`permissions` session rules are kept per session id.** The engine is one process-wide,
   session-agnostic object (`createPermissionEngine`), so the fix is an id, not a move into session
   state (first draft of this ADR, corrected on 2026-11-08 after reading the engine):
   - `allow`, `addRule` and `removeRule` take an optional `{ session: string }`; `decide` and
     `decideAsync` take the session id (`DecideOptions.session`; the plugin passes
     `ctx.session.id`).
   - A rule added with scope `'session'` and a session id applies only to decisions for that id. It
     stays memory-only exactly as spec 18 §2 documents (not stored, `persist` is not called), in a
     bounded map (oldest session dropped), so a restart still forgets it.
   - Scope `'session'` without a session id keeps today's engine-wide behavior and warns once per
     engine (`W_PERMISSION_SESSION_RULE_GLOBAL`); it is deprecated and removed at 1.0. This keeps
     every existing caller (the coder example, the team program gate) working.
   - `grants.by` does not apply to rules. Per-principal rules and `rules(ctx)`/`roots(ctx)` on the
     engine have no second consumer yet (ADR-0062 rule of two) and are not part of P62.
   It ships without an option, as a bug fix with a regression test: a rule added for session S1
   does not apply in S2.
4. **No new approval concepts.** Expiry, quorum and "who may answer" are separate follow-ups.

## Consequences

+ A shared session can let each person grant for themselves. The motor-style per-session maps in
  apps can go.
+ Nothing changes for apps that do not set the options (apart from the rule-scoping fix).
− `by: 'principal'` makes grants per person, so the same tool asks once per person in a shared
  session. That is the intent, and it is more prompts.
− Two settings to document and test in combination (four cases in the conformance matrix).
− Stored grant keys differ by mode; switching the mode on existing sessions ignores old keys (they
  read as no grant, never as a wider one).

## Alternatives considered

- **Always key by principal when one exists.** Rejected: changes behavior for every adopter that
  already sets a principal for other reasons.
- **Make the key a hook** (`tool.grantKey`). Rejected for now: `tool.grantScope` already scopes the
  tool part, and a second hook would let two plugins disagree about one key.
- **Fix the one-step delay by re-validating differently.** Rejected: the delay protects AI SDK's
  re-validation of the answered calls, and excluding exactly those call ids does the same job.
