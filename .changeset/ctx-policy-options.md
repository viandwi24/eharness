---
"eharness": minor
---

Policy options take `(ctx)` so they can vary per session, person or tenant: `subagent({ agents })` is evaluated with the ctx before every turn of the parent (it was once per session).

`clock({ timezone })` receives the ctx (the zone of the `datetime` and `sleep` tools can follow the person).
