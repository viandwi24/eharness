---
"eharness": patch
---

The remote MCP connector gets a `reviewToolChanges` setting (default off): a server's updated tools are used at once, and only a connection that asks to review keeps the definitions a chat first saw until accepted (`McpSourceSpec.pinDefinitions`, `remoteMcpSource({ pinDefinitions })`).
