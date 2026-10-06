---
"eharness": minor
---

Request-scoped client tools and page context (spec 11 §7.1, ADR-0028): a request can declare
client tools and a page context for one turn, both treated as untrusted.

- **Opt-in.** `handleChatRequest(session, body, { clientTools, pageContext })` reads
  `body.clientTools` / `body.pageContext` only when enabled (default off: the fields are ignored,
  exactly as before). `SendOptions` gains `clientTools`, `clientToolsOptions`, `pageContext` and
  `pageContextOptions` for server code; the same validation runs.
- **Validated, all or nothing:** name pattern, reserved names, collisions with any server tool
  (static, skill, source, deferred) or the output tool, schema type / byte / depth caps, in-document
  `$ref` only, `maxTools`, `allow` list or predicate. Failure is a run error (`EH_INVALID_INPUT`,
  `details.reason: 'client-tools'`) before anything is stored.
- **No implied permission:** declarations become AI SDK tools without `execute` (risk `unknown`);
  approval policy, risk routing and `tool.approve` apply; outputs pass `tool.after` and the output
  limits.
- **Position and cache:** request tools come after `tool_search`, before the output tool, sorted
  by name; a changed set busts the cached prefix and raises `W_CACHE_BUST`
  (`details.reason: 'client-tools'`) once per turn.
- **Timeout when the tab closes:** with `timeoutMs`, a pending client call gets `waitId`,
  `timeoutAt` and `onTimeout` and expires through the external wait machinery (live timer, inbox
  `wait-timeout` item, `expireWaits()`), answered with `CLIENT_TOOL_TIMED_OUT` or your `onTimeout`.
- **Page context** is a turn reminder block framed as data (`PAGE_CONTEXT_PREAMBLE`, tags
  neutralised, capped with `W_PAGE_CONTEXT_LIMITED`); never stored, never in `instructions`.
- New exports: types `ClientToolDeclaration`, `ClientToolsOptions`, `PageContextEntry`,
  `PageContextOptions`, `PendingClientTool`; the helper `neutralizeTags(text, tags)` (shared by
  memory, group and page context; their output is unchanged); texts `PAGE_CONTEXT_PREAMBLE`,
  `CLIENT_TOOL_TIMED_OUT`.
- **Type-level:** `ChatRequestBody` gains optional `clientTools` / `pageContext`;
  `ChatRequestOptions` extends `Omit<SendOptions, …>` for the four new fields and redefines
  `clientTools` / `pageContext` as opt-in objects; `PendingState.clientTools` entries gain optional
  `waitId` / `result`; `EH_INVALID_INPUT` `details.reason` gains `'client-tools'`, `'page-context'`
  and `'request-context-with-steer-or-collect'`; `WarningCode` gains `W_PAGE_CONTEXT_LIMITED`.
