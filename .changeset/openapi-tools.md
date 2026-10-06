---
"eharness": minor
---

New subpath `eharness/openapi`: `openApiTools(spec, options)` turns an OpenAPI 3.0/3.1 JSON
document into a tool source — include/exclude by method, path, tag and operationId, app-supplied
`baseUrl` and `headers` (the spec's `servers` are ignored by default), risk from the HTTP method,
local `$ref` resolution with a recursion guard, schema summarization, a tool-count guard and
deferral; failures return as error strings. Also `riskFromMethod()` (spec 17, ADR-0032).
