---
"eharness": patch
---

Sessions and the turn runtime: `agent.session(id)` now returns a live session (cached, idle
eviction, `closeSession()` / `close()`). `send()` runs a multi-step turn (one `streamText` call per
step) and returns a `HarnessRun` whose `stream` is the AI SDK UI message stream (`toResponse()`,
`pipeTo()`, `attach()` to replay and follow a running turn); `run.result` never rejects. Turns
persist the user message and the assistant message after every step through a `MessageAdapter`,
keep namespaced plugin state through a `StateAdapter`, follow the normative lifecycle (lock,
commit point, `input.submit`, `turn.prepare`, `step.prepare`, `step.end`, `turn.beforeEnd`,
`tool.before` / `tool.after` / `tool.approve`, `message.beforeSave`), stop by the documented stop
rules (`complete`, `tool-pending`, `max-steps`, `cost-cap`, `timeout`, `aborted`, `blocked`, …),
answer interrupted tool calls, recover turns of crashed processes, and lay out prompts for caching
(two stable system blocks, turn/step reminders, stable tool order, Anthropic `cacheControl`).
Also: `session.inject()` (next-turn delivery), `messages()`, `stats()`, `events()`, `abort()`,
`clearGrants()`. New entry points: `memoryMessages()` / `memoryState()` in
`eharness/storage/memory`, and `messageAdapterConformance()`, `stateAdapterConformance()` and
`scriptedModel()` in `eharness/testing`. Fix: `eh.event` payloads without `data` are valid.
Not yet available (coming before 0.1.0): `respond()`, `regenerate()`, `edit()`, `compact()`,
`ifBusy: 'queue' | 'steer'` and `inject()` with `deliver: 'next-step'` / `wake`.
