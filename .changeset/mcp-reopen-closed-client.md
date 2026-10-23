---
'eharness': patch
---

`mcpServerSource`: a tool call that fails because the session's MCP client was closed mid-turn (rebuilt agent, failed listing) now reconnects and retries once instead of failing for the rest of the turn. Mid-request `Connection closed` errors are never retried, and a client dropped after a failed listing is not closed while a call still runs on it.
