# ADR-0032: OpenAPI tools: outbound HTTP and SSRF defaults

Status: **Proposed** · Date: 2026-10-06 · Builds on: [ADR-0007](0007-single-package-subpaths.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0025](0025-external-risk-and-mcp-annotations.md)

## Context

Teams want to expose an existing HTTP API to an agent from its OpenAPI document. Prior art (ADK
`OpenAPIToolset`, Semantic Kernel OpenAPI plugins, LangChain's OpenAPI toolkit with
`allow_dangerous_requests`, FastMCP `from_openapi` route maps) agrees on two things: generated
tools are worse than curated ones, so filtering is mandatory, and a tool that makes HTTP requests
from model-chosen input is an SSRF and credential-exfiltration surface. The AI SDK ships no such
helper. This is the first shipped plugin that performs outbound HTTP on its own.

## Decision

- **A plugin, not core.** `eharness/openapi` is a `ToolSource` built only on the public API
  (ADR-0008); core keeps no HTTP code.
- **JSON only, OpenAPI 3.0 / 3.1.** No YAML library (hard rule 10); YAML or Swagger 2.0 fails
  with `EH_CONFIG_INVALID` and a conversion hint. Everything is validated when `openApiTools()` is
  called, not at call time.
- **The application supplies the base URL.** The spec's `servers` (and path/operation-level
  `servers`) are untrusted input: they are used only with an explicit `useSpecServers: true`, and
  then only `servers[0]`. Every request URL must stay under the base URL (same origin and path
  prefix); path parameters are percent-encoded and `.` / `..` / empty values are rejected.
- **No remote `$ref`s.** Only local `#/…` references resolve; a remote reference is a config error
  and nothing is fetched at load. Cycles and depth overruns become `{}` with a description.
- **Redirects never cross the fence.** `fetch` runs with `redirect: 'manual'`; same-base redirects
  are followed (bounded), anything else becomes an error string. Credentials are never sent
  elsewhere.
- **Credentials come from the application only.** `headers(ctx, op)` supplies them per call; the
  model cannot set `authorization`, `cookie`, API-key headers declared by the spec's
  `securitySchemes`, or any undeclared header, and credentials are never echoed into results.
- **Risk from the method, set by the app.** `metadata.risk` is `riskFromMethod` (GET/HEAD/OPTIONS
  read, DELETE destructive, other write) unless `risk(op)` overrides it; the guide recommends
  `'external'` for third-party APIs. Spec content never lowers a risk.
- **Failures are strings** (hard rule 6); a tool-count guard (`maxTools`, default 64) and
  `defer: 'auto'` keep large APIs usable; responses are read up to a character limit, then core
  output limits apply.

## Consequences

- Safe by default, at the cost of one required option (`baseUrl`) and curation work.
- Not supported in 0.5.0: cookie parameters (ignored), non-JSON request bodies (operation skipped
  with a warning log), binary or streamed responses (error string), `outputSchema`, remote refs,
  OAuth flows (the app's `headers()` owns tokens).
- DNS-level SSRF (a trusted hostname resolving to an internal address) is outside the library's
  reach; a custom `fetch` can enforce network policy.
