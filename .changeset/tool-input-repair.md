---
'eharness': patch
---

Repair tool input before the call: when a model sends a tool argument in the wrong type (an `object`/`array` as a JSON string, a number or boolean where only `string` is declared, a clean number string where `number`/`integer` is declared, per array item), the core converts it. For JSON Schema tools (MCP, OpenAPI) this happens before the call; for zod tools, which the AI SDK validates first, the core now supplies `repairToolCall` and retries an invalid input once repaired (too-long strings are left to the model; `config.repairToolCall` still runs after). Raises `W_TOOL_INPUT_REPAIRED` once per tool and property.
