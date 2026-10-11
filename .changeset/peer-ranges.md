---
"eharness": minor
---

Peer dependency floors rise to the versions the library is built and tested against: `ai@^7.0.137` (was `^7.0.127`) and optional `@ai-sdk/mcp@^2.0.73` (was `^2.0.66`). Migration: update `ai` (and `@ai-sdk/mcp` if you use `eharness/mcp`) to at least these versions; `eharness/mcp` is type-checked against `@ai-sdk/mcp` 2.0.7x.
