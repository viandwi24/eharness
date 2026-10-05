---
"eharness": minor
---

Raised minimum peer versions: `ai@^7.0.127` (was `^7.0.123`) and the optional `@ai-sdk/mcp@^2.0.66` (was `^2.0.63`) — the locked, tested versions. UI chunk order is public API and older 7.0.x patches order the transient `data-eh.status { state: 'tool' }` chunk differently around `start-step`; upgrade `ai` (and `@ai-sdk/mcp` if you use `eharness/mcp`) together with eharness 0.4.
