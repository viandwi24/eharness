# ADR-0028: Request-scoped client tools and page context

Status: **Proposed** · Date: 2026-10-06 · Amends: ADR-0013

## Context

Chat UIs know things the server does not: the current page, a selection, what the browser can do
(read the location, fill a form, open a dialog). Prior art (CopilotKit `useFrontendTool` /
`useCopilotReadable`, AG-UI `RunAgentInput.tools` / `context`, ChatKit client tools, assistant-ui
frontend tools) lets the **request** carry tool declarations and context. AI SDK already has the
mechanics: a tool without `execute` is a client tool, the UI answers with `addToolOutput`, and
`jsonSchema()` builds a schema from plain JSON Schema (verified against `ai` 7.0.128).

The cost: everything in such a request is **attacker-controlled** if the page is (XSS, a malicious
embedded page, a user editing the request). Declarations are text the model reads and an
instruction channel; context is text the model reads. Meanwhile a changed tool list invalidates
the provider's prompt cache from the tools onwards (ADR-0013).

## Decision

- **Opt-in, per request.** `handleChatRequest` reads `body.clientTools` / `body.pageContext` only
  when the application enables the matching option (default off: the fields are ignored, so a 0.4
  route behaves as before). The core API takes the same data through `SendOptions`; the session
  validates it the same way (server code is trusted, its inputs are not).
- **Validate, all or nothing.** Names must match the provider pattern, must not be reserved, equal
  a server tool (static, skill, source, deferred) or the output tool, and are unique; schemas are
  JSON objects of `type: 'object'` within a byte cap and depth/node caps, with only in-document
  `$ref`s; the count is capped; an `allow` list or predicate narrows it further. A failure is a run
  error (`EH_INVALID_INPUT`, `reason: 'client-tools'`) before the commit point. No prefix
  (`client_…`) is added: the frontend handles calls by its own names, and a collision is rejected
  rather than renamed (a rename would silently change what the frontend sees).
- **No implied permission.** A declaration becomes a tool without `execute` with no `metadata`
  (risk `unknown`); approval policy, risk routing and `tool.approve` hooks apply unchanged. An approved
  call parks as a client call (the approving `respond()` stops `tool-pending` with it in
  `clientTools`, without a model step); the server never runs it. It never
  executes server code; its output passes `tool.after` and the output limits.
- **Fixed position, honest cache cost.** Request tools sit after `tool_search` and before the
  output tool, sorted by name. Any change busts the cached prefix of that request; the core warns
  `W_CACHE_BUST` (`reason: 'client-tools'`) when the set differs from the previous turn and the
  guide says to keep declarations stable and put volatile data in page context. Deferring request
  tools behind `tool_search` to avoid the bust is not done in 0.5.0 (revisit with code mode).
- **Page context is data in the turn reminder.** It is delivered like the memory plugin's pinned
  files: a fixed preamble, one framed block per entry, tags neutralised inside values (a shared core
  helper, `neutralizeTags`), a total character cap with head + tail truncation and a warning. It is
  never stored, never in `instructions` (volatile content stays out of the cached prefix), so a
  regenerated turn does not see an old context (apps that need it durable put it in the user
  message).
- **A tab that closes times out.** A call of a request tool is a `clientTools` pending entry; with
  `timeoutMs` it gets `waitId`, `timeoutAt` and `onTimeout` and takes part in the ADR-0027 machinery
  (timer, durable inbox item, `expireWaits()`, compare-and-set). The recorded timeout result makes
  the call answered, the continuation runs without the client, and a late client answer is
  `unknown-id`. `resolveWait()` never resolves a client call: only its client, or its timeout.
- **Continuation needs no stored declaration.** The projection does not need the tool definition
  of a stored call (`convertToModelMessages({ tools })` only serves `toModelOutput`), so a
  `respond()` accepts an answer for a tool that is not re-declared; the tool is just not offered to
  the model again. `useChat` re-sends the body on every request, so the normal flow re-declares.

## Consequences

- Public additions: `SendOptions.clientTools` / `clientToolsOptions` / `pageContext` /
  `pageContextOptions`, `ChatRequestBody.clientTools` / `pageContext`,
  `ChatRequestOptions.clientTools` / `pageContext`, types `ClientToolDeclaration`,
  `ClientToolsOptions`, `PageContextEntry`, `PageContextOptions`, `PendingClientTool` (with
  `waitId`, `result`), `neutralizeTags`, fixed texts `PAGE_CONTEXT_PREAMBLE` /
  `CLIENT_TOOL_TIMED_OUT`, warning `W_PAGE_CONTEXT_LIMITED`, `EH_INVALID_INPUT` reasons
  `'client-tools'`, `'page-context'`, `'request-context-with-steer-or-collect'`.
  `ChatRequestOptions` no longer extends `SendOptions` for the four new fields (it extends an
  `Omit`), so a `SendOptions` value that sets them is not assignable to it.
- A model that is unaware of a tool still sees its past calls in history after the tab left; a
  provider that rejects tool calls without tool definitions (when a turn has no other tool at all)
  would reject such a continuation. Not seen with the shipped provider adapters; recorded as an
  open question of P24.
- The client is trusted to describe its own tools honestly: a lying description can mislead the
  model, but not widen what the server executes (nothing runs server-side) or bypass approval.
- A malicious page can still burn tokens with big (within caps) schemas or context; the caps and
  `maxTools` bound it, and the application bounds who may enable the options.
