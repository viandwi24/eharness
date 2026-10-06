# P28 — OpenAPI → tools plugin (`eharness/openapi`)

Status: todo · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art item **#6** (verdict GENERIC-plugin, not core: ADK `OpenAPIToolset`,
Semantic Kernel OpenAPI plugins, LangChain OpenAPI toolkit with `allow_dangerous_requests`,
FastMCP `from_openapi` route maps — all warn that auto-generated tools are worse than curated
ones; filtering is mandatory).

Process (0.5.0): develop first, one gate at the end of the phase, consolidated review at the end
of the release.

## Goal

`openApiTools(spec, options)` turns an OpenAPI 3.0 / 3.1 document (a parsed object or a JSON
string — no YAML dependency) into a `ToolSource`: one AI SDK `tool()` per selected operation with
a `jsonSchema()` input built from its parameters and request body (local `$ref`s resolved with a
recursion guard, schemas summarized to stay small), a risk from the HTTP method (P21 traits), an
app-supplied base URL (the spec's `servers` are never trusted by default — SSRF) and app-supplied
auth headers per request. Calls use the Web `fetch`; HTTP and network failures come back as error
strings the model can read; a tool-count guard and deferral keep big APIs usable.

## Specs / docs to read

- `docs/specs/09-tools-and-mcp.md` §1 (AI SDK tools, name pattern, reserved names), §2
  (`ToolSource`), §3 (`mcpServer` as the shape to mirror: `allow` / `deny`, prefix, `defer:
  'auto'`), §4 (output limits), §5 (timeouts)
- `docs/specs/02-context-registry.md` §3.2–§3.3 (tool sources, deferred tools, `tool_search`),
  §6 rule 1 (stable order)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (`EH_CONFIG_INVALID`), §1.1 (tool errors as
  strings), §2 (`W_TOOL_SOURCE_FAILED`)
- `docs/specs/11-interaction.md` §3.2 (risk; P21 `external`)
- ADR-0007, ADR-0008, ADR-0025 (P21)
- `src/mcp/server.ts` (source layout, `defer: 'auto'`), `src/registry/tool-source.ts`,
  `scripts/check-imports.ts`, `tsdown.config.ts`, `scripts/smoke.mjs`

**AI SDK verified (2026-10-06):**

- AI SDK ships **no** OpenAPI → tools helper (searched `vercel/ai` main; only a third-party CLI is
  listed in `content/docs/02-foundations/04-tools.mdx`).
- `jsonSchema(schema | Promise | () => schema, { validate? })` returns a `Schema<T>`; the docs name
  OpenAPI definitions as a use case (`https://ai-sdk.dev/docs/reference/ai-sdk-core/json-schema`).
- `tool({ description, inputSchema, execute, metadata })` — `metadata` is a JSON object not sent to
  the model; `tool({ title })` is deprecated
  (`https://github.com/vercel/ai/blob/main/packages/provider-utils/src/types/tool.ts`).
- `deferLoading` on tools for `tool_search` (used by `mcpServer`, spec 02 §3.3) unchanged in
  7.0.128. **No devDependency bump needed.**
- OpenAPI facts (verify while writing): 3.0 `nullable` vs 3.1 JSON Schema 2020-12 types,
  parameter `in: path | query | header | cookie`, `style` / `explode` defaults
  (`https://spec.openapis.org/oas/v3.1.1.html`, `https://spec.openapis.org/oas/v3.0.4.html`).

## Owns

`src/openapi/**` (new subpath `eharness/openapi`), `docs/specs/17-openapi-plugin.md` (new),
ADR-0032 (new: outbound HTTP in a shipped plugin, SSRF defaults), `package.json` `exports`,
`tsdown.config.ts`, `scripts/check-imports.ts`, `scripts/smoke.mjs`, `CLAUDE.md` (rule 4 list +
layout), `docs/guides/openapi-tools.md` (new), `examples/openapi-tools.ts` (new, with a small
fixture spec).

## Design

```ts
import { openApiTools } from 'eharness/openapi'

openApiTools(spec: object | string /* JSON only */, {
  name: string                               // source id 'openapi:<name>', default prefix `${name}_`
  baseUrl: string | ((ctx) => string)        // REQUIRED; spec `servers` ignored unless useSpecServers
  useSpecServers?: boolean                   // default false
  headers?: (ctx: HarnessContext, op: OperationInfo) => HeadersInit | Promise<HeadersInit>   // auth etc.
  include?: OperationFilter; exclude?: OperationFilter        // { methods?, paths? (glob), tags?, operationIds? } | (op) => boolean
  names?: Record<string, string> | ((op) => string)         // operationId → tool name
  prefix?: string
  risk?: (op: OperationInfo) => ToolRisk | undefined        // default riskFromMethod
  maxTools?: number                          // default 64 → EH_CONFIG_INVALID above (after filters)
  defer?: boolean | 'auto'                   // 'auto' = deferred above 20 tools (MCP_AUTO_DEFER_THRESHOLD)
  timeoutMs?: number                         // default 30_000 per call
  maxResponseChars?: number                  // before core output limits; default core limit
  schema?: { maxDepth?: number /* 6 */; maxDescriptionChars?: number /* 300 */ }
  fetch?: typeof fetch                       // injectable (tests, proxies)
}): ToolSource
export function riskFromMethod(method: string): ToolRisk   // GET/HEAD/OPTIONS read, DELETE destructive, others write
```

Normative rules (spec 17):

1. **Input**: a parsed object or a JSON string; `openapi` must be `3.0.x` or `3.1.x` (Swagger 2.0
   and YAML strings → `EH_CONFIG_INVALID` with a hint to convert). Validation happens in
   `openApiTools()`, never at call time.
2. **Tool per operation** (after include/exclude): name = `names` → `operationId` → `<method>_<path
   slug>`, sanitized to `^[a-zA-Z0-9_-]{1,64}$` and prefixed; duplicates → `EH_CONFIG_INVALID`.
   Description = summary + description, capped. Input schema = `{ path?, query?, headers?, body? }`
   object (grouped so parameter names never collide); only header parameters declared by the
   operation are accepted; `cookie` parameters are unsupported (excluded with a warning).
3. **`$ref`**: only local refs (`#/…`) are resolved; remote refs → `EH_CONFIG_INVALID` (no fetch at
   load). Cycles and depth > `maxDepth` become `{}` with a description `(recursive: <ref>)`.
   3.0 `nullable` is converted to a type union. Unsupported keywords are dropped, not passed.
4. **Base URL / SSRF**: requests go only to `baseUrl` + the operation path (path params URL-encoded,
   no `..`, the final URL must start with `baseUrl`); the spec's `servers` are used only with
   `useSpecServers: true`. Redirects are not followed across origins (`redirect: 'manual'` and a
   same-origin check).
5. **Auth** comes only from `headers(ctx, op)` (per call, per session runtime); the model can
   never set `authorization` / `cookie` headers, and they are never echoed into results.
6. **Risk** (P21): `metadata.risk` = `risk(op) ?? riskFromMethod(method)` (trusted app metadata).
   The guide recommends `external` for third-party APIs.
7. **Results**: 2xx JSON → parsed value; other content types → text; non-2xx → error string
   `HTTP <status> <statusText>: <body head>`; network error / timeout → error string; never throw
   (CLAUDE.md rule 6). Output limits apply (spec 09 §4).
8. **Count guard**: more than `maxTools` selected → `EH_CONFIG_INVALID` naming the count and the
   filters; `defer: 'auto'` defers above 20.

## Checklist

- [ ] ADR-0032 "OpenAPI tools: outbound HTTP and SSRF defaults" (why a plugin, JSON only, base URL
      required, no remote refs).
- [ ] Spec 17 (rules 1–8, options, error texts); spec 09 new §8 "OpenAPI tools" pointer.
- [ ] `src/openapi/`: loader + validator, operation filter, ref resolver with cycle guard, schema
      summarizer (3.0 → JSON Schema), tool builder (`tool()` + `jsonSchema()`), request builder
      (path / query `style` + `explode` defaults, JSON body), fetch with timeout and
      `abortSignal`, result mapping; imports core only via `src/index.ts`.
- [ ] Subpath wiring: `exports['./openapi']`, tsdown entry `openapi/index`, `check-imports`
      `subpaths`, smoke exports, CLAUDE.md rule 4 + layout.
- [ ] Tests (injected `fetch`, fixture specs: petstore-like 3.0 and 3.1, a recursive schema, a
      200-operation spec): names / prefix / duplicates; include / exclude by method, path glob,
      tag, operationId; ref cycle → `{}`; remote ref → config error; YAML string → config error;
      baseUrl enforced (`servers` pointing at `169.254.169.254` ignored); path param `../` cannot
      escape; cross-origin redirect not followed; auth header from `headers()` and model-supplied
      `authorization` rejected; non-2xx / timeout / network error as strings; risk mapping;
      count guard and `defer: 'auto'`.
- [ ] `examples/openapi-tools.ts` (offline, fake `fetch`) in `examples.test.ts`; guide
      `docs/guides/openapi-tools.md` (curate with include, describe well, approval for writes).
- [ ] Changeset; board; gate (incl. `build` + `check:package`).

## Acceptance criteria

- [ ] A filtered OpenAPI spec yields callable AI SDK tools with correct risk, and every failure is
      a string result.
- [ ] No request can leave `baseUrl`; auth never comes from the model.
- [ ] No new runtime dependency (no YAML, no ref library); `eharness/openapi` imports core only
      via `src/index.ts`.
- [ ] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New subpath `eharness/openapi`: `openApiTools(spec, options)` tool source (OpenAPI 3.0/3.1 JSON,
  include/exclude, names, app-supplied `baseUrl` and `headers`, risk from method, local `$ref`
  resolution with a recursion guard, schema summarization, tool-count guard, deferral) and
  `riskFromMethod()`.

## Open questions

1. **Default risk for POST/PUT/PATCH**: `'write'` or `'external'`? The API is outside the system
   by definition, but internal APIs are common. Pick: `'write'` (DELETE `'destructive'`), and the
   guide shows `risk: (op) => op.method === 'get' ? 'read' : 'external'` for third-party APIs.
2. **Flat vs grouped input** (`{ petId }` vs `{ path: { petId } }`). Pick: grouped (no name
   collisions between `in` locations; schemas stay faithful).
3. **Response schema** as tool `outputSchema`? Pick: no (large, and AI SDK would validate
   outputs); responses are returned as-is under output limits.
4. **Streaming / binary responses**: Pick: unsupported in 0.5.0 (binary → error string naming the
   content type); see the roadmap "Binary files" row.

## Requests to other phases

- P21: `ToolRisk` / `metadata.risk` (built there).
- P29: guide index, README plugin list, reference, results table row #6.

## Dependencies

**P21** (hard: risk metadata and `external`). Wave W4, in parallel with P27.
