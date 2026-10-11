---
"eharness": minor
---

**BREAKING:** `mcpServerSource({ pinDefinitions })` now defaults to `true` for remote servers (`transport` config with `type: 'http' | 'sse'`, also when a resolver returns one) and stays `false` for stdio and `MCPTransport` instances. Migration: pass `pinDefinitions: false` to keep accepting every definition change of a remote server. Structured (JSON) tool output is now serialized and framed as untrusted content like text results when `wrapUntrusted` is on, and so are the error messages of failed MCP tool calls (the `error-text` the model sees), since server-provided text is untrusted either way.
