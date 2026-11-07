---
"eharness": minor
---

`close({ inFlight: 'interrupt' })` on the agent, `closeSession(id, options)` and the session ends a running turn exactly as `session.recover()` repairs a crashed one: `stop: 'interrupted'`, dangling tool calls answered `INTERRUPTED_CRASH`, an `EH_TURN_INTERRUPTED` notice and `activeTurn` cleared. The default stays `'abort'`. New type `CloseOptions`.
