# ADR-0054: Wakes held while items wait for an answer are durable

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0012](0012-approvals-server-owned-pending.md), [ADR-0024](0024-durable-inbox-port.md), [ADR-0046](0046-durable-background-subagents-in-park-mode.md) (see spec 11 §6.3, spec 05 §12)

## Context

Background children report through `inject('eh.event', …, { deliver: 'next-step', wake: true })`.
When the parent session waits for a client tool answer (`ask_user_question`), an approval or an
external wait, spec 11 §6.3 already said the wake is *held* so a background event never denies
what the user is looking at. The hold was an entry of the **in-memory** turn queue of the
instance that received the inject. Two consequences showed up in the team example:

- A report injected from instance B while instance A had parked the session, or a report that
  arrived before a restart (`bun --watch`, a deploy), was never run: the kind message stayed
  stored (so it reached the model with the *next* user message) but the lead did not wake.
  Nothing failed loudly; the user saw reports in the chat and an agent that never answered them.
- `inject()` decided "idle, start a wake now" from the **cached** state of the receiving
  instance, which cannot see a pending set that another instance stored.

## Decision

- A wake that cannot run now because items wait for an answer is stored in the durable inbox as
  `wake` items (the existing item kind), when `storage.inbox` exists:
  - `inject(…, { wake: true })` on a session with no turn here reads the **stored** state; a
    stored pending set (or a live foreign turn) makes it enqueue the item and return;
  - a turn that ends `tool-pending` with undelivered `wake` events enqueues one item per event
    (`messageId` = the event).
- The drain already releases claimed items while the stored state is pending; the instance that
  completes the `respond()` continuation (or `resolveWait`, a timeout, a `send` that denies) drains
  at its turn end and runs one wake turn for the consecutive wake items. No new item kind, no
  port change.
- Without an inbox nothing changes: the wake is held in the in-memory queue.
- The `respond()` continuation never projects the held events; the wake turn that follows does,
  after the continued message (stored order = model order, ADR-0011). Delivering held events into
  the continuation as `data-eh.input` was rejected: it would put them between the tool result and
  the model's next step for no gain, and the wake turn already gives one coherent follow-up.
- Events stored after a pending message are valid: `respond()` matches the pending message against
  the newest non-kind message.

## Consequences

Patch-level behaviour fix (a wake that used to be lost now runs once). Reports of a state
broken before this change stay stored without a wake item: they reach the model at the next turn
(an app can enqueue `wake` items for them through its own `InboxAdapter`).
