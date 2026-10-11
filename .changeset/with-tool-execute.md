---
"eharness": minor
---

Add the experimental `withToolExecute(tool, execute)` and `withToolFields(tool, fields)` helpers: copy a tool with a new `execute` or changed `deferLoading` / `toModelOutput` / `metadata`, keeping every other field, with the `Tool` cast in one place. Internal wrappers (filesystem, MCP, OpenAPI, registry) use them.
