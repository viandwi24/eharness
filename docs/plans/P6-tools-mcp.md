# P6 — Tool sources and MCP

Status: todo · Branch: `phase/P6-tools-mcp`

## Goal

Dynamic tools: `defineToolSource` with refresh and deferral, automatic `tool_search`, and the
`mcpServer()` source over `@ai-sdk/mcp` with per-session clients, allow/deny, prefixing, lazy
connect and optional definition pinning.

## Specs

- 02 §3.2–§3.3, §5
- 09 (all)
- 01 §5 (tool hooks, execute wrapper notes)

## Owns

`src/registry/tools.ts` (dynamic parts: sources, deferral, `tool_search` injection), `src/mcp/**`.
The per-step discovery tracking in the loop is P2's (spec 02 §3.3); P6 makes it observable by
adding deferred tools.

## Checklist

1. [ ] `defineToolSource`, `open`/`list`/`close` lifecycle, `refresh`, name validation,
   `W_TOOL_SOURCE_FAILED`, `W_SHADOWED`.
2. [ ] Deferral: set `deferLoading` on source tools; add `toolSearch()` as `tool_search` when any
   deferred tool exists; reserved-name checks.
3. [ ] `mcpServer`: `await import('@ai-sdk/mcp')` at connect (type-only static imports),
   transport resolver per session, lazy (first turn) / eager (session open) connect,
   `client.tools()`, allow/deny, prefix, `defer: 'auto'`, `maxRetries` (tool calls only), close
   on dispose, retry failed connects at the next turn.
4. [ ] Pinning: `await fingerprintTools(...)` stored under `plugins[<owner>]['mcp:<name>:pins']`
   keyed by server tool name, `detectToolDrift` on list, exclusion + `W_MCP_DRIFT`,
   `clearMcpPins(agent, sessionId, name)`.
5. [ ] Tests with an in-process MCP server (custom `MCPTransport` test double, no network):
   listing, prefixing, allow/deny, drift, connection failure, close on session close.
6. [ ] Integration: a deferred source is not visible until `tool_search`, then callable next step.
7. [ ] Tool output limits (spec 09 §4): `maxChars`, `perTool`, head+tail truncation helper shared
   with the guard, `evict` via the `toolOutputs` service with fallback, `W_TOOL_OUTPUT_LIMITED`
   (scenario 32).
8. [ ] Timeout / repair mapping table of spec 09 §5 covered by tests (per-tool `toolMs`,
   `repairToolCall`, preliminary results + `addUsage` in a subagent-style test tool).

## Acceptance criteria

- [ ] `eharness/mcp` works when `@ai-sdk/mcp` is installed; without it, importing still works,
      `connect: 'eager'` fails session open with `EH_CONFIG_INVALID` ("install @ai-sdk/mcp") and
      lazy connects produce `W_TOOL_SOURCE_FAILED` (CI `smoke.mjs --no-mcp` covers this).
- [ ] No MCP client outlives its session (leak test with 100 open/close cycles).

## Open questions

## Requests to other phases

- From P1: `defineToolSource()` exists (`src/registry/tool-source.ts`, runtime brand
  `'~toolSource'`, `isToolSource()`); `config.mcp` entries must be tool sources.
  `TOOL_NAME_PATTERN` and `RESERVED_TOOL_NAMES` live in `src/registry/static.ts` /
  `src/registry/types.ts`.

- From P2: `src/registry/tools.ts` `listSourceTools()` already lists sources per turn with
  `refresh` caching (`open.sourceCache`), `W_TOOL_SOURCE_FAILED` (retried next turn), name
  validation (`W_INVALID_TOOL_NAME`) and shadowing (`W_SHADOWED`, reserved names too); session
  open calls `source.open(ctx)` and registers `close()` as a disposer (`src/session/session.ts`).
  Missing: `defer` → `deferLoading`, the automatic `tool_search`, and output limits — call them
  from `wrapTool()` in `src/registry/wrap.ts` after the `tool.after` chain (final values only).
  Discovery tracking is done: `collectDiscovered()` / `toolSearchNames()` in
  `src/loop/steps.ts`, `seedDiscovered()` in `src/session/turn.ts`, and
  `registry.toolsForStep(discovered)` every step. `W_DEPRECATED` for tool-level `needsApproval`
  is emitted in `resolveTurnRegistry()`.
