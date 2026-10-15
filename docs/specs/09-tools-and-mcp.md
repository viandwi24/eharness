# Spec 09 — Tools and MCP

Status: **Accepted (reviewed for 0.1.0)**, updated through 0.8.0. Modules: `src/registry/tools.ts`, `src/mcp` (`eharness/mcp`).

## 1. Tools are AI SDK tools

Any `Tool` from `ai` (`tool()`, `dynamicTool()`, provider-defined tools) is accepted unchanged.
eharness only:

- resolves `(ctx) => Tool` inputs once per session (spec 02 §3.1);
- runs `tool.before` through AI SDK `experimental_refineToolInput` (before approval and
  execution, spec 01 §5);
- wraps `execute` (`{ ...tool, execute: wrapped }`) to run `tool.after`, apply output limits (§4),
  write `data-eh.status { state: 'tool', tool }` and turn thrown errors into `HarnessToolError`
  (spec 10 §1.1);
- builds the per-step approval function (spec 11 §3), reading each tool's traits (risk,
  `idempotent`, MCP hints) from its `metadata` with `toolTraits()` (spec 11 §3.2);
- adds `tool_search` when deferred tools exist (spec 02 §3.3);
- adds skill tools (spec 07 §4.3).

Not wrapped: tools without `execute` (client tools, §6), provider-executed tools and
`toolSearch()` (AI SDK replaces its `execute`; observe searches through stream parts instead).

Reserved tool names: `tool_search`, `load_skill`, `read_skill_file`, `search_skills`. Using them →
`EH_DUPLICATE_TOOL`.

Tool approval is supported through AI SDK `toolApproval` (spec 11 §3). eharness code never sets
the deprecated tool-level `needsApproval`; a tool that sets it itself still works (AI SDK
evaluates it) but warns once with `W_DEPRECATED`.

## 2. `ToolSource`

Defined in spec 02 §3.2. Semantics:

- `open()` at session open (before the first `list()`), `close()` on session close/eviction.
- `list()` errors (and a `list()` that does not settle within `config.toolSources.timeoutMs`):
  warning `W_TOOL_SOURCE_FAILED`, source contributes no tools for that period; the turn continues.
  The source is asked again after a backoff (spec 02 §3.2).
- Returned tool names are validated (`^[a-zA-Z0-9_-]{1,64}$`); invalid names are skipped with
  `W_INVALID_TOOL_NAME`. Reserved names are skipped with `W_SHADOWED`.

## 3. `mcpServerSource` (`eharness/mcp`)

Thin `ToolSource` over `@ai-sdk/mcp` (optional peer dependency).

```ts
import { mcpServerSource } from 'eharness/mcp'

export function mcpServerSource(opts: McpServerSourceOptions): ToolSource

export interface McpServerSourceOptions {
  /** Short name; used as tool prefix and source id 'mcp:<name>'. ^[a-z0-9-]{1,32}$ */
  name: string
  /** A transport config for createMCPClient({ transport }), or a resolver per session (per-user
   *  credentials, custom transports). An MCPTransport instance → EH_CONFIG_INVALID (one client per session). */
  transport: McpTransportConfig | ((ctx: HarnessContext) => McpTransportInput | Promise<McpTransportInput>)
  /** Tool name prefix. Default `${name}_`. Use '' to disable. */
  prefix?: string
  /** Allow/deny lists on the server's tool names (before prefixing). */
  allow?: string[]
  deny?: string[]
  /** Mark tools deferred → discovered via tool_search. Default 'auto' = deferred when the server exposes > 20 tools. */
  defer?: boolean | 'auto'
  /** 'lazy' (default): connect at the first turn of the session. 'eager': connect at session open. */
  connect?: 'lazy' | 'eager'
  /** Pin tool definitions on first connect and block changed definitions (drift). Default: true for remote (`type: 'http' | 'sse'`) transports, false otherwise. */
  pinDefinitions?: boolean
  /** Frame text and structured (JSON) results as untrusted content (spec 03 §10). Default true. */
  wrapUntrusted?: boolean
  /** createMCPClient `maxRetries`: retries of tools/call requests only (not connect). Default 0. */
  maxRetries?: number
  /** Default 15 000: limit for connecting and for listing tools; a silent server fails with `EH_MCP_TIMEOUT` (`W_TOOL_SOURCE_FAILED`). */
  timeoutMs?: number
  refresh?: 'session' | 'turn'
  /** Trusted risk for this server's tools (spec 11 §3.2): written to each tool's metadata.risk.
   *  A function gets the server tool name (before prefixing) and the annotations as sent;
   *  undefined keeps the derived (tighten-only) risk. */
  risk?: ToolRisk | McpRiskFunction
}

export type McpRiskFunction = (tool: { name: string; annotations?: McpToolAnnotations }) => ToolRisk | undefined

export type McpTransportConfig = Exclude<MCPClientConfig['transport'], MCPTransport>
export type McpTransportInput = MCPClientConfig['transport']
```

`defer: 'auto'` defers when more than 20 tools remain after allow/deny.

Invalid options (name pattern, missing transport, unknown `defer`/`connect`/`risk`, negative
`maxRetries`, …) throw `EH_CONFIG_INVALID` from `mcpServerSource()`.

Lifecycle:

- `@ai-sdk/mcp` is loaded with `await import('@ai-sdk/mcp')` at connect time (only type imports
  are static), so importing `eharness/mcp` never fails; a missing package becomes a clear
  `W_TOOL_SOURCE_FAILED` warning, and `mcpServerSource()` called with `connect: 'eager'` rejects the
  session open with `EH_CONFIG_INVALID` ("install @ai-sdk/mcp").
- One MCP client **per session** (credentials can differ per user). Created at the first turn
  (`lazy`) or at `open()` (`eager`); closed when the session closes. `ToolSource.close()` carries
  no session, so the source closes a session's client when that session's `ctx.signal` aborts
  (session close/eviction, and a failed session open, spec 05 §2) and `close()` waits for those
  clients to finish closing. A session closed while it is still opening releases its connection
  in `open()` and never connects. A `transport` must therefore be a
  config or a resolver that returns a **new** `MCPTransport` per call; an `MCPTransport` instance
  is rejected with `EH_CONFIG_INVALID`. An eager connect that fails for another reason than the
  missing package does not fail the session open: it only logs (`ctx.log.warn`), and the
  `W_TOOL_SOURCE_FAILED` warning comes from the first `list()`, which retries the connect.
- `list()` calls `client.tools()`, applies allow/deny, prefixes names, sets `deferLoading` per
  `defer`. `defer: 'auto'` counts the tools that remain after allow/deny and drift exclusion. A
  failing `client.tools()` closes the client, so the next turn reconnects.
- `pinDefinitions` (default `true` when the transport config, or the config a resolver returns, has `type: 'http' | 'sse'`; `false` for stdio-like and `MCPTransport` instances; an explicit value always wins): on first successful connect, `await fingerprintTools(tools)` of **all** server
  tools (before allow/deny) is stored in the session state under
  `plugins[<owner plugin>]['mcp:<name>:pins']`, keyed by the **server** tool name (before
  prefixing). On later lists `detectToolDrift()` runs; changed or added tools are **excluded**
  and reported with one `W_MCP_DRIFT` per listing (`details.tools`: the excluded server names
  that allow/deny would have exposed). Pins are never updated by a drifted listing.
- Re-pinning is an explicit application action:
  `clearMcpPins(agent, sessionId, name, opts?: { stateAdapter?: StateAdapter }): Promise<void>`
  (exported from `eharness/mcp`). The server is resolved through the agent's own configuration:
  the `mcpServerSource()` named `name` in the root `mcp` / `tools` config; if there is none (e.g. a
  source contributed by a plugin), more than one, or the instance is shared by several agents, it
  throws `EH_CONFIG_INVALID` instead of guessing (use one `mcpServerSource()` instance per agent). It
  never reads or writes another agent's sessions. If the session is open in that source (live),
  it clears through the live
  session state (so the turn-end state write cannot restore the old pins); otherwise it uses the
  session's effective `StateAdapter` (`opts.stateAdapter` when the session used a
  `SessionOptions.storage.state` override, else the agent's `storage.state`; the pins key is
  removed from every plugin namespace, written with `setIf` when available). With the agent's
  default in-memory storage (not reachable through the public API) it opens the session
  (`ready()`, without connecting the MCP server) and clears through the live state. Pins are
  re-created on the next listing that finds none (for a live `refresh: 'session'` source: the next
  session open).
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) stay
  in the tool's `metadata.annotations` exactly as `@ai-sdk/mcp` copied them (only the hints the
  server sent). They are untrusted and only tighten the derived risk (spec 11 §3.2):
  `destructiveHint: true` → `'destructive'`, else `openWorldHint: true` → `'external'`;
  `readOnlyHint` never yields `'read'`, `idempotentHint` never yields `idempotent`. The raw hints
  reach `tool.approve` as `hints`.
- `risk` (0.5.0): a constant, or a function called per server tool at every listing (after
  allow/deny and drift exclusion, before prefixing and deferral), sets `metadata.risk` — trusted,
  so it wins over the hints (`mcpServerSource({ risk: 'read' })` for a trusted read-only server).
  `undefined` keeps the derived risk; a function that throws or returns an invalid value keeps
  the derived risk and logs `ctx.log.warn`. Pins (`fingerprintTools`) are computed on the
  server's tools before `risk` is applied.
- Result mapping (`wrapUntrusted`, default `true`): the listed tool's `toModelOutput` is wrapped
  so a `text` output and every `text` part of a `content` output becomes
  `untrustedContent(text, { source: 'mcp', name: '<server>/<tool>' })` (spec 03 §10; the app should include `UNTRUSTED_CONTENT_INSTRUCTIONS`, but the frame's own
  wording already tells the model that content inside is data, not instructions). Image/file
  parts and the `isError` flag are unchanged. A `json` output (structured results; a tool without
  `toModelOutput` is wrapped with the default mapping first: a string output is framed as text,
  anything else is `json`) is serialized and framed as text too (an `isError` result's text is framed: the server wrote it). A call that throws (JSON-RPC or
  transport error) is framed too: the message of the thrown error, which reaches the model as
  `error-text`, is wrapped in the same frame (aborts are not). The stored UI tool output stays the raw MCP
  result; only the model-visible projection is framed. `mcpServerSource` exposes tool calls only (no
  resource reads).
- Connection failures and timeouts (`timeoutMs`, `EH_MCP_TIMEOUT`; a client that connects too late
  is closed) → `W_TOOL_SOURCE_FAILED`, zero tools, retried after the source backoff (spec 02 §3.2)
  regardless of `refresh`.

Top-level sugar: `defineHarnessAgent({ mcp: [mcpServerSource({...})] })` is identical to
`tools: [mcpServerSource({...})]` — the `mcp` slot exists for readability.

### 3.x Remote servers with a fresh bearer (`remoteMcpSource`)

`remoteMcpSource({ name, url, headers?, getAccessToken?, allow?, deny?, prefix?, defer?, risk? })`
(`risk` is a constant `ToolRisk`) is `mcpServerSource` (so remote definitions are pinned by default) over a streamable-HTTP transport whose `authProvider` (`bearerAuthProvider`) returns
`getAccessToken()` for **every** request, so a refreshed OAuth token is used without reconnecting.
`listRemoteMcpTools(spec)` connects once, returns `{ name, description?, annotations? }` and closes
the client. Both are used by `eharness/connectors` (spec 24 §9).

## 4. Tool output limits

Large tool outputs are the main cause of context blow-ups and write amplification. The core limits
every final output of a wrapped tool **before** it reaches the model, the stream and storage:

```ts
toolOutput?: {
  maxChars?: number                          // default 50_000 per result (JSON-serialized length)
  perTool?: Record<string, number | false>   // per final tool name; false = unlimited
  strategy?: 'truncate' | 'evict'            // default 'truncate'
}
```

- Order: `execute` → `tool.after` hooks → limit. Preliminary outputs (§5) are not limited; only
  the final one.
- **`truncate`:** strings keep the first 70% and the last 30% of the budget around a marker
  `TOOL_OUTPUT_TRUNCATED` (spec 10 §5); a cut point never splits a UTF-16 surrogate pair (it
  moves by one character instead). Structured outputs are serialized
  first; if the result is still over budget the output becomes
  `{ truncated: true, preview: <truncated JSON string>, originalChars: N }`. The preview is sized so
  that its kept characters plus the JSON escaping they need (it is a string inside a JSON value)
  fit the budget; the marker is not counted.
- Size: a string output is measured by its length, any other output by the length of its JSON
  serialization. `perTool` wins over `maxChars`.
- **`evict`:** requires the `toolOutputs` service (provided by the filesystem plugin,
  spec 08 §2). The full output (strings as is, structured outputs as indented JSON) is written to
  `/.eharness/tool-outputs/<toolCallId>.txt` and the model gets the truncated preview plus
  `Full output saved to <path>; use read_file with offset/limit to see more.` — appended after a
  blank line for strings, as `note` in `{ truncated, preview, originalChars, note }` for structured
  outputs. Without the service (or when `put` fails), `evict` falls back to `truncate`.
- A tool's own `toModelOutput` is bypassed for the `{ truncated: true, … }` form (it is sent as
  a `json` output), because that form no longer has the shape the converter expects (e.g. MCP
  `CallToolResult`s).
- Media bytes are not counted: an MCP `CallToolResult` (`{ content: [...] }`) with `image`/`audio`
  parts is measured without their base64 `data`. Over budget, only its `text` parts are shortened
  (sharing the budget by length), `structuredContent` is dropped and the media parts and the shape
  are kept, so the tool's `toModelOutput` still applies.
- Media outputs (spec 08 §12) are not limited: `read_file` stores a small `media-ref` object and its
  `toModelOutput` produces the image; a custom tool that returns base64 inside its output is limited
  like any structured output (return a reference and read the bytes in `toModelOutput` instead).
- **Media offload.** With the `toolMedia` service (filesystem plugin, spec 08 §2) every `image` /
  `audio` part of an MCP-style result (`{ content: [...] }`) is written as a file after the limit
  and `tool.after` hooks ran, and replaced in the **stored** output by
  `{ type, mimeType, ref: { type: 'media-ref', path, version, mediaType, bytes } }` (no `data`),
  followed by a text part `[Saved as <path> (<mediaType>, N KB). To send or attach this image, use
  this path with a tool that uploads files.]`, so the model can pass the file on (a chat upload);
  screenshots do not accumulate base64 in the message store. Other text parts and the shape stay. The
  tool's `toModelOutput` gets the bytes back as `data` (live step wire and projection, spec 03 §6
  step 5b, which also applies `keepImages`). A failed write keeps the original part and raises
  `W_TOOL_MEDIA_OFFLOAD`; without the service nothing changes. Applications that persist the
  messages elsewhere resolve `ref.path` through the same file system (the team example serves it
  as a library view URL).
- Every limited result raises `W_TOOL_OUTPUT_LIMITED` (details: `tool`, `toolCallId`,
  `originalChars`, `maxChars`, `strategy`).
- The guard (spec 06 §6) and the compaction transcript use the same truncation helper.

### 4.1 Tool calls of one step

`toolCalls: { maxPerStep?: number }` (default 24). A model can degenerate and emit hundreds of
parallel calls in one step. Every wrapped tool call is admitted per step:

- an exact repeat of a call of the same step (same tool, same JSON input) does not run: it is
  answered `Skipped: the same <tool> call with the same input was already made in this step; ...`;
- past `maxPerStep` admitted calls, a call does not run: `Skipped: more than N tool calls in one
  step. ...`.

Both are tool errors (`HarnessToolError`, same text in the UI, storage and on the wire); the model
continues in the next step. Unwrapped tools (`tool_search`, client and provider tools) are not
counted.

## 5. Timeouts, retries, repair, preliminary results

| Concern | Mechanism |
|---|---|
| Tool timeout | `settings.timeout.toolMs` or per tool `settings.timeout.tools.<name>Ms` (AI SDK); a timed-out tool becomes a tool error |
| Step timeout | `settings.timeout.stepMs` / `chunkMs` / `firstChunkMs` → abort chunk → stop `'timeout'` (spec 04 §2) |
| Turn timeout | `loop.turnTimeoutMs` (the core's own timer) |
| Provider retries | `settings.maxRetries` (request) and `settings.streamRetries` (after streaming started; `reset-step` forwarded) |
| Malformed tool calls | `config.repairToolCall` → AI SDK `repairToolCall`; otherwise the invalid call becomes a tool error the model can read |
| Input normalization | `tool.before` hooks (via `experimental_refineToolInput`) |

**Preliminary results.** A tool whose `execute` returns an `AsyncIterable` streams preliminary
outputs (`preliminary: true` in the UI part) and its last value is the final output. The wrapper
passes the iterable through untouched and applies `tool.after` and limits to the final value only.
This is how a subagent tool streams the child's progress into the parent message; usage of the
child is reported with `ctx.turn.addUsage()`.

## 6. Client-side tools

A tool without `execute` is a client tool: the model's call is streamed to the UI and the turn
ends with `stop: 'tool-pending'` until the application calls `respond({ toolOutputs })`
(spec 11 §4) — `handleChatRequest` does this for `useChat`'s `addToolOutput`. Client outputs pass
through `tool.after` and output limits like server outputs.

**Request-scoped client tools (0.5.0).** A request can declare client tools for one turn
(`SendOptions.clientTools`, `handleChatRequest` option `clientTools`; spec 11 §7.1). They are
built with `jsonSchema()` as tools without `execute` and no `metadata`, validated against the
server's own tool names (a client can never shadow a tool), and are subject to the approval
rules like any tool. Their pending calls may carry `timeoutAt` / `onTimeout`.

**External tools (0.5.0).** `externalTool()` (spec 11 §4.2) is also a tool without `execute`, but
its result comes from the server side, not from the client: the call is pending kind `externals`
(not `clientTools`), `start` hands the work to the outside world, and the result arrives through
`session.resolveWait()`. A client output for such a call is ignored by `handleChatRequest` and
`EH_INVALID_INPUT` (`'wrong-kind'`) from `respond({ toolOutputs })`. It is detected by a symbol
property on the tool (it survives the wrapping); like client tools it is not wrapped, its
outputs pass `tool.after` and the output limits when they are recorded.

## 7. Deferred tools in practice

```ts
tools: [
  defineToolSource({
    id: 'catalog',
    defer: true,
    refresh: 'turn',
    list: async (ctx) => buildToolsForTenant(ctx.runtime.tenantId),
  }),
]
```

The model sees `tool_search` and non-deferred tools; after searching, matching tools are callable
from the next step and stay callable for the rest of the turn (eharness tracks discoveries across
steps, spec 02 §3.3). Up to five matches are returned per search (AI SDK behaviour).

## 8. OpenAPI tools

`openApiSource()` (`eharness/openapi`) is a tool source that turns an OpenAPI 3.0 / 3.1 JSON document
into tools, with an app-supplied base URL and auth headers; see [spec 17](17-openapi-plugin.md).
