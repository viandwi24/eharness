---
"eharness": patch
---

Connector `update` follows `auth.when`: a changed endpoint asks for a sign in only when the connector signs in with the new settings, switching a custom MCP server to OAuth sets `needs-auth`, and leaving OAuth clears a pending sign in.
