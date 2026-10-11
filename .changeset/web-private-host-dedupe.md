---
"eharness": minor
---

**BREAKING:** `eharness/web` no longer re-exports `isPrivateHost`; import it from `eharness` (the core export `web_fetch` now uses too, one implementation for IPv4-mapped, NAT64, 6to4 and Teredo ranges). Migration: `import { isPrivateHost } from 'eharness'`.
