---
"eharness": minor
---

Add `reminders.turnPlacement: 'turn-start' | 'end'` to the agent config (spec 02 §5, §6 rule 2a, ADR-0073). The default `'turn-start'` keeps today's layout. With `'end'` the turn reminder goes after the last message (before the step reminder), so the next turn's request starts with the exact bytes of the previous turn's stable prefix and the whole previous turn stays in the provider's prompt cache; the reminder itself is then uncached on every step. For Anthropic, combine it with `cache: { mode: 'breakpoints' }`.
