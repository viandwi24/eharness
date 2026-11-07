---
"eharness": minor
---

New agent option `grants: { by: 'session' | 'principal'; applyAt: 'continuation' | 'now' }` (spec 11 §3.1, ADR-0070). `by: 'principal'` keys a session grant by the principal that asked (`<principal id>\u0000<tool key>`), so one person's `remember: 'session'` does not answer another person's request in a shared session; `session.clearGrants(principal?)` clears one principal's grants, and a principal `id` with a NUL character is rejected. `applyAt: 'now'` applies a recorded grant at once to every call except the ones the same `respond()` answered. Both defaults keep today's behavior; the default of `applyAt` is planned to flip at 1.0.
