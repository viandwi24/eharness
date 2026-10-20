---
'eharness': patch
---

Repair tool input before the call: when a model sends an `object` or `array` argument of a JSON Schema tool (MCP, OpenAPI) as a JSON-encoded string, the core parses it if the schema does not also allow `string`. Raises `W_TOOL_INPUT_REPAIRED` once per tool and property.
