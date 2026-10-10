---
"eharness": patch
---

`eharness/mcp`: type-check against `@ai-sdk/mcp` 2.0.7x, whose `createMCPClient()` returns `MCPClient | ManagedMCPClient` and whose tool types use their own schema generics (the plugin only needs `tools()` and `close()`).
