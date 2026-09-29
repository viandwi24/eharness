---
"eharness": patch
---

Tool sources and MCP: `defineToolSource({ defer: true })` marks a source's tools deferred and the
core adds AI SDK's `toolSearch()` as `tool_search` whenever a deferred tool exists (discovered tools
stay callable for the rest of the turn and after reloads); `defineToolSource` validates `refresh`,
`defer`, `open` and `close`. Tool output limits (`toolOutput: { maxChars, perTool, strategy }`,
default 50,000 characters): final outputs are truncated head + tail around
`TOOL_OUTPUT_TRUNCATED` (structured outputs become `{ truncated, preview, originalChars }`), or
evicted to the filesystem plugin's `toolOutputs` service with a `read_file` hint, with
`W_TOOL_OUTPUT_LIMITED`. New `eharness/mcp` entry: `mcpServer()` turns an MCP server into a tool
source over the optional peer `@ai-sdk/mcp` (loaded lazily) with one client per session, lazy or
eager connect, allow/deny, prefixing, `defer: 'auto'`, `maxRetries`, reconnects after failures
(`W_TOOL_SOURCE_FAILED`), definition pinning with drift exclusion (`W_MCP_DRIFT`) and
`clearMcpPins()`.
`eharness/mcp` no longer exports the `experimental_placeholder` constant (it was a placeholder with
no behaviour). `read_file` now keeps its continuation hint inside `maxReadChars`, so a full window
fits the default tool output limit.
