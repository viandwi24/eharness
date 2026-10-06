# Spec 17 — OpenAPI tools plugin (`eharness/openapi`)

Status: **Draft (0.5)**. Module: `src/openapi/*`. Built only with the public core API (ADR-0008).
Design: [ADR-0032](../decisions/0032-openapi-tools-outbound-http.md).

`openApiTools(spec, options)` turns an OpenAPI 3.0 / 3.1 document into a `ToolSource` (spec 02
§3.2, shape of `mcpServer`, spec 09 §3): one AI SDK `tool()` per selected operation with a
`jsonSchema()` input. Calls use the Web `fetch`.

## 1. API

```ts
import { openApiTools, riskFromMethod, OPENAPI_AUTO_DEFER_THRESHOLD } from 'eharness/openapi'

openApiTools(spec: object | string /* JSON */, {
  name: string                         // source id 'openapi:<name>', default prefix `${name}_`; ^[a-z0-9-]{1,32}$
  baseUrl?: string | ((ctx: HarnessContext) => string)   // required unless useSpecServers
  useSpecServers?: boolean             // default false
  headers?: (ctx, op: OperationInfo) => HeadersInit | Promise<HeadersInit>
  include?: OperationFilter | OperationFilter[]
  exclude?: OperationFilter | OperationFilter[]
  names?: Record<string, string> | ((op) => string)       // operationId → name, before prefixing
  prefix?: string
  risk?: (op) => ToolRisk | undefined
  maxTools?: number                    // 64
  defer?: boolean | 'auto'             // 'auto': deferred above 20 tools
  timeoutMs?: number                   // 30_000
  maxResponseChars?: number            // 50_000
  schema?: { maxDepth?: number /* 6 */; maxDescriptionChars?: number /* 300 */ }
  fetch?: typeof fetch
}): ToolSource

type OperationFilter =
  | { methods?: string[]; paths?: string[] /* globs */; tags?: string[]; operationIds?: string[] }
  | ((op: OperationInfo) => boolean)
interface OperationInfo {
  method: string /* lowercase */; path: string; operationId?: string; tags: string[]
  summary?: string; description?: string; deprecated: boolean
}
riskFromMethod(method: string): ToolRisk
```

## 2. Rules

1. **Input.** A parsed object or a JSON string. `openapi` must be `3.0.x` / `3.1.x`. YAML text,
   Swagger 2.0 and other versions throw `EH_CONFIG_INVALID` (with a conversion hint) from
   `openApiTools()` — never at call time. Remote `$ref`s throw `EH_CONFIG_INVALID`.
2. **Selection.** Every `get | put | post | delete | options | head | patch` operation is
   selected unless `include` excludes it or `exclude` matches (`exclude` wins). Within one filter
   object all given fields must match (list fields match any entry; `paths` are globs: `*` within a
   segment, `**` across); an array of filters matches if any does.
3. **Tools.** Name = `names` → `operationId` → `<method>_<path slug>`, sanitized to
   `^[a-zA-Z0-9_-]{1,64}$` and prefixed (`<name>_` by default). Duplicates throw
   `EH_CONFIG_INVALID`. Description = `METHOD /path`, summary, description (capped). Input schema:
   `{ path?, query?, headers?, body? }` (grouped so names never collide; `additionalProperties:
   false`; `path` / `query` / `headers` / `body` are `required` when any member is). Path-item
   parameters merge with operation parameters (the operation wins). Only declared header
   parameters are accepted. Not supported: `cookie` parameters (ignored) and operations whose
   required request body is not JSON (skipped); both are logged once through `ctx.log.warn`. An
   optional non-JSON body is ignored.
4. **`$ref` and schemas.** Local refs resolve; a cycle or depth over `schema.maxDepth` becomes
   `{ description: '(recursive: <ref>)' }` (`'(too deep: …)'` without a ref). 3.0 `nullable`
   becomes a type union and boolean `exclusiveMinimum/Maximum` become numeric; `readOnly`
   properties are dropped from request bodies; unsupported keywords (`discriminator`, `xml`,
   `example`, …) are dropped. Descriptions are capped to `schema.maxDescriptionChars`.
5. **Base URL / SSRF.** Requests go to `baseUrl` + the operation path. The spec's `servers` are
   ignored unless `useSpecServers: true` (then `servers[0]` with variable defaults, when `baseUrl`
   is not given). `baseUrl` must be an absolute `http(s)` URL without credentials. Path parameters
   are percent-encoded; `.`, `..` and empty values are rejected; the final URL must stay under the
   base URL. `redirect: 'manual'`: redirects within the base URL are followed (≤ 5; 301/302/303
   on non-GET/HEAD become GET without body), anything else returns `REDIRECT BLOCKED: …`.
6. **Auth.** Only `headers(ctx, op)` supplies credentials; its headers override model-supplied
   ones. The model cannot send `authorization`, `proxy-authorization`, `cookie`, `host`,
   `content-type`, `content-length`, `transfer-encoding`, `connection`, any `apiKey`-in-header name
   from `components.securitySchemes`, or an undeclared header: `REJECTED: …` (nothing is sent).
   Credentials are never part of a result.
7. **Risk.** `metadata.risk = risk(op) ?? riskFromMethod(method)`; an invalid `risk()` result or
   a throw falls back to the method default with `ctx.log.warn`. `metadata.openapi` carries
   `{ method, path, operationId? }`.
8. **Results.** Never throws for expected failures (hard rule 6). 2xx JSON → the parsed value;
   text types → the text; 204/205/empty → `OK: HTTP <status> <text>`; binary or other content
   types → `UNSUPPORTED: …`. Non-2xx → `HTTP <status> <statusText>: <first 500 chars of the
   body>`. Bodies are read only up to `maxResponseChars`; longer ones return the head plus
   `[truncated: …]`. Network error → `Request failed: <message>`; timeout → `Request timed out
   after <ms> ms.`; abort (session close or the turn's signal) → `Request aborted.`. Invalid
   input → `REJECTED: …` / `INVALID: …` strings (unknown or missing parameters). Core output limits
   (spec 09 §4) apply afterwards.
9. **Count guard and deferral.** More than `maxTools` selected operations throws
   `EH_CONFIG_INVALID` naming the count and the filters. `defer: 'auto'` (default) sets
   `deferLoading` above `OPENAPI_AUTO_DEFER_THRESHOLD` (20) tools (spec 02 §3.3).

## 3. Not in 0.5.0

Cookie parameters, non-JSON request bodies (forms, multipart, binary), binary or streamed
responses, `outputSchema`, remote refs, security-scheme flows (OAuth) — the application's
`headers()` owns tokens.
