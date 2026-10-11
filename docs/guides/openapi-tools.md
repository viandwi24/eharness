# OpenAPI tools

`eharness/openapi` exposes the operations of an OpenAPI 3.0 / 3.1 JSON document as agent tools
(contract: [spec 17](../specs/17-openapi-plugin.md), design:
[ADR-0032](../decisions/0032-openapi-tools-outbound-http.md)). Runnable offline:
[`examples/openapi-tools.ts`](../../examples/openapi-tools.ts).

```ts
import { defineHarnessAgent } from 'eharness'
import { openApiSource } from 'eharness/openapi'

// yours: `model`, `specJson` (the OpenAPI document, object or JSON string)
const orders = openApiSource({
  spec: specJson,
  name: 'orders',
  baseUrl: 'https://orders.example.com/v1',
  headers: (ctx) => ({ authorization: `Bearer ${ctx.runtime.token}` }),
  include: { tags: ['orders'], methods: ['get', 'delete'] },
})
defineHarnessAgent({
  model,
  tools: [orders],
  approval: { risk: { destructive: 'user-approval' } },
})
```

## Curate, do not mirror

A generated tool per endpoint is worse than a few well-chosen ones. Pick operations with
`include` / `exclude` (methods, path globs, tags, operationIds, or a function), rename with
`names`, and fix thin descriptions in the spec. More than 64 selected operations is a config
error (`maxTools`, default 64); above 20 the tools are deferred behind `tool_search`
(`defer: 'auto'`). Requests time out after `timeoutMs` (default 30 000).

## Safety defaults

- **Base URL**: you supply it. `servers` in a spec you did not write could point at an internal
  address; use `useSpecServers: true` only for specs you trust. Requests cannot leave the base URL
  (path values are encoded, `..` is rejected, redirects elsewhere are not followed).
- **Auth**: only `headers(ctx, op)` — per call, from `ctx.runtime` — and the model cannot send
  `authorization`, `cookie` or API-key headers. Never put secrets in the spec.
- **Approval**: tool risk comes from the method (`GET` read, `DELETE` destructive, others write).
  For third-party APIs mark everything that changes state as external:
  `risk: (op) => (op.method === 'get' ? 'read' : 'external')`, then route it with `approval.risk`
  (spec 11 §3.2) or an [approval guard](guard.md).
- **Failures** (HTTP errors, timeouts, bad input) come back as readable strings, so the model can
  correct itself. Responses over `maxResponseChars` (default 50 000) are cut.
- **Responses are untrusted data.** By default (`wrapUntrusted: true`) successful
  content is wrapped by `untrustedContent()` in an `<untrusted-content source="openapi">` frame
  (JSON becomes compact JSON text inside it), like MCP text; errors and status lines stay unwrapped.
  Add `UNTRUSTED_CONTENT_INSTRUCTIONS` (exported from `eharness`) to your instructions;
  `wrapUntrusted: false` opts out and returns the parsed JSON value instead.

## Limits

JSON documents only (convert YAML first), local `$ref`s only, JSON request bodies only, no binary
or streamed responses, no OAuth flows (your `headers()` owns tokens).
