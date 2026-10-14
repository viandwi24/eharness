---
"eharness": minor
---

New module `eharness/identity` (Draft): one person with many platform accounts. `PersonStore` port (async) with `memoryPersonStore`, accounts keyed by platform and stable native id, audit events, hashed single-use pairing codes with `pairingGuard`, `resolveRole` (suspended or left means guest) and `decideByRisk`. Conformance suite `personStoreConformance` in `src/testing/identity.ts`.
