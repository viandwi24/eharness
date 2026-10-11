# ADR-0057: Session invariants enforced in code, fuzz tests, multi-instance conformance

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0014](0014-interrupted-tool-calls-answered.md), [ADR-0054](0054-held-wakes-while-pending.md), [ADR-0055](0055-approval-answer-wins-and-schema-valid-denials.md), [ADR-0056](0056-restart-recovery-and-background-reconcile.md)

## Context

Four bugs in a row came from the same place, the session state machine meeting a second instance or
an odd message: wakes started while a session was pending, held wakes lost across instances, a
stored message failing `UIMessage` validation silently dropped on load (taking the pending state
with it), duplicated wake turns, approvals answered twice. Each was fixed after the fact by a
targeted test. Nothing checked the properties themselves.

## Decision

1. **Invariants (spec 05 §15)** are written down and checked: I1 every saved message validates
   against AI SDK `UIMessage` (with the agent's data part schemas); I2 ascending unique ids; I3 one
   result per tool call; I4 unique pending ids that name open tool parts; I5 one active turn and a
   pending message that is the newest; I6 sane state numbers.
2. **Policy for a message that fails validation at save time** (`debug.invariants`): in
   development and test it is a programmer error (`EH_INVALID_MESSAGE`, nothing saved); in
   production the core repairs known shapes, warns `W_INVALID_MESSAGE` and saves the message anyway.
   "Repair, don't drop": a message that holds pending state is the worst one to lose. On load, such
   a message (named by `pending.messageId` / `activeTurn.messageId`) is kept with a warning instead
   of dropped.
3. **A seeded fuzz test** (no new dependency) drives two instances through random interleavings and
   asserts the invariants, the documented error set and the absence of runaway loops.
4. **`multiInstanceConformance`** (`eharness/testing`) runs the cross-instance cases against any
   storage backend, so application adapters (Postgres, ...) prove them in their own CI.

## Consequences

The first fuzz runs found real bugs (spec 05 §15, "Multi-instance rules"): a hot loop in the gated
send path, inbox claims renewed forever by a restarted process with a stable instance id, a queue
held by approvals another instance answered never starting, a dirty idle cache blind to a foreign
pending state, a stale view rejecting a valid answer as stale, and a claim/fail/release loop when a
turn kept failing before its commit point. All fixed with regression coverage (the fuzz seeds, the
conformance cases, `claim-owner.int.test.ts`).

Costs: one extra `safeValidateUIMessages` per saved message (microseconds; messages are small), and
a default that throws in `NODE_ENV=test|development` (set `debug: { invariants: false }` to opt out).

## Amendment note (2026-10-11)

Update (0.8, P39): `debug.invariants` is explicit-only; it is no longer switched on by `NODE_ENV` `test` or `development`. The repository's own tests enable it through a Bun test preload (`scripts/test-preload.ts`), which also fails any test that raises `W_INVARIANT_VIOLATION` unless it opts out with `allowInvariantViolation(pattern)`. Applications put `debug: { invariants: true }` in their test setup.
