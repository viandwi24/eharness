# ADR-0055: A person's approval wins on re-validation; denied parts stay schema-valid

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0012](0012-approvals-server-owned-pending.md) (see spec 03 §6-7, spec 11 §3, spec 18 §12)

## Context

A team session in `auto` mode paused after repeated classifier blocks and asked a person to approve
a call. The person approved. The stored assistant message was then dropped on the next cold load
(`W_INVALID_MESSAGE`), the pending approval vanished and answering it returned "stale".

Chain of events:

1. `approval.decided` (`by: 'user'`) called `engine.noteApproval()`, which **resumed** auto mode.
2. The `respond()` continuation makes AI SDK re-validate every approved call through `tool.approve`
   (`validateApprovedToolApprovals`). The engine was no longer paused, so it ran the classifier on
   the call the person had just approved. The classifier failed (a provider credit error) and a
   failure is a block, so the call was **denied**.
3. AI SDK emits only `tool-output-denied` for a re-validation denial; its UI reducer sets
   `state: 'output-denied'` but leaves `approval.approved: true`. AI SDK's `UIMessage` schema
   requires `approved: false` there, so the stored message failed validation and was dropped.

## Decision

- **The person's answer wins.** `noteApproval(toolCallId)` (called by the permissions plugin from
  `approval.decided`) remembers the call; `decideAsync` never classifies it again (rules, pinned
  asks and `dontAsk` still apply, they are evaluated before the classifier).
- **Stored `output-denied` parts are always schema-valid.** Persistence and projection set
  `approval.approved = false` (reason "Approved, but denied when the call was re-validated by the
  approval policy." when none). Cold load repairs the same inconsistency instead of dropping the
  message (`W_REPAIRED_MESSAGE`). This is a targeted exception to "drop invalid messages" (spec 03
  §7): the inconsistency is known, lossless to repair, and dropping loses a pending approval. Every
  other validation failure still follows `onInvalidMessage`.
- **A classifier outage is not a block.** `ClassifierUnavailableError` (thrown by `modelClassifier`
  for any failed call) still denies (fail closed) but is reported as `auto: 'unavailable'` /
  `unavailable` event and never counts towards the pause.
- `modelClassifier` sets `maxOutputTokens` (default 1024) and `temperature` (default 0).

## Consequences

Integration suites save through `spyMessages`, which now validates every saved message with AI SDK
`safeValidateUIMessages`, so a schema-invalid stored message fails the test that produced it.

## Amendment note (2026-10-11)

Update (0.8, P39): `AutoVerdict.decision` gains `'ask'`: a classifier that cannot or should not decide hands the action to a person. Classifier and judge outages and over-long inputs ask a person, they never deny and never approve. The classifier is now the `decide` role of the shared judge engine (ADR-0060).
