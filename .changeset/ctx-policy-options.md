---
"eharness": minor
---

Policy options take `(ctx)` so they can vary per session, person or tenant: `subagent({ agents })` is evaluated with the ctx before every turn of the parent (it was once per session).

`clock({ timezone })` receives the ctx (the zone of the `datetime` and `sleep` tools can follow the person).

`webFetch({ allow, deny })`: `allow(host, ctx)` and `deny` may be functions (sync or async); a function that throws fails closed.

`compaction.summarizeAt`, `keepLast` and `model` (also the default flush model) may be functions of the ctx, read once per turn; an invalid or throwing value keeps the default.
