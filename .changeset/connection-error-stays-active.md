---
'eharness': patch
---

`activateConnectors` keeps a connection whose status is `error` active (its tools stay; a call that cannot reach the server answers with a readable error). Only `needs-auth` and `disabled` connections are left out, so one failed health probe no longer takes an agent's tools away until the next test.
