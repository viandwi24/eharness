---
"eharness": patch
---

`remoteMcpSource({ refresh: 'turn' })` lists the server's tools before every turn instead of once per session, so a long-lived session sees tools the server added or changed.
