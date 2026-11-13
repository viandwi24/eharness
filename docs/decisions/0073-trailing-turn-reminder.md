# ADR-0073: Opt-in trailing turn reminder for cross-turn prompt caching

Status: **Accepted** · Date: 2026-11-13 · Related: [ADR-0013](0013-cache-friendly-prompt-layout.md) · Spec: [02](../specs/02-context-registry.md)

## Context

ADR-0013 places the turn reminder (turn-refresh instructions, page context, the output
instruction) directly before the current turn's first message, and never stores it. Within a turn
that is cache-friendly: every step repeats the same reminder at the same place. Across turns it is
not. The next turn no longer sends that reminder, so its request diverges from the previous
requests exactly where the reminder was, and everything after that point (the previous turn's user
message, tool calls, tool results and answer) is billed as uncached input again on the first step
of every turn. The claim "cached prefix survives across steps and turns" in ADR-0013 holds for the
system blocks and older history only. A turn with large tool results pays for them twice.

Re-sending the old reminder is not possible: reminders are volatile and never stored (spec 02 §5,
spec 05 §3), and storing them would put volatile text into history.

## Decision

Add `reminders.turnPlacement: 'turn-start' | 'end'` to the agent config. `'turn-start'` (default)
keeps ADR-0013 unchanged. `'end'` appends the turn reminder after the last message of the wire,
before the step reminder, so nothing volatile ever sits inside what becomes history: the request of
turn N+1 starts with the exact bytes of the stable part of turn N's last request. The first step of
a `respond()` continuation keeps the default placement, because AI SDK needs that wire to end with
the tool message (spec 11 §4).

## Consequences

- With `'end'`, a turn's first step re-sends only the new input, the previous answer and the
  reminder; the whole previous turn stays cached (measured: about 24 000 of 32 000 request
  characters uncached per new turn with the default, about 3 500 with `'end'`, for an 8 000
  character system prompt, a 3 000 character reminder and a 20 000 character tool result per turn).
- The reminder itself is uncached on every step, not only on the first step of the turn: `'end'`
  pays reminder size × steps to save previous-turn size × turns. Short reminders and large tool
  results favour `'end'`; long reminders with many small steps favour the default. That is why it
  is opt-in.
- The model sees the reminder after the newest message instead of before it. Models follow
  trailing `<system-reminder>` blocks well (the step reminder already sits there), but it is a
  behavioural difference to test per app.
- Providers that cache only at explicit breakpoints (Anthropic) need `cache: { mode: 'breakpoints' }`
  so the breakpoint lands on the last stable message rather than after the reminder.
