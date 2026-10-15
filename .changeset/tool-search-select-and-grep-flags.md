---
'eharness': patch
---

`tool_search` understands `select:<name>`, says why a name cannot be loaded (new optional `ToolSourceDef.explain`) and stops repeated identical searches. A call to an unloaded or unknown tool gets a short readable error instead of the list of every available tool. `grep` accepts a leading inline flag group (`(?i)`, `(?s)`, `(?m)`) and hints at other unsupported syntax.
