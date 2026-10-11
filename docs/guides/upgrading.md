# Upgrading

- [0.7 → 0.8](#upgrading-to-08)
- [0.6 → 0.7](#upgrading-to-07)

## Upgrading to 0.8

0.8 adds six Draft subpaths (`eharness/providers`, `eharness/connectors`, `eharness/activity`,
`eharness/http`, `eharness/client`, `eharness/client/react`) and many session APIs. Nothing is
removed. A few defaults and behaviours change; the table lists each one with what to do.

**Peer dependencies rise:** `ai@^7.0.137` (was `^7.0.127`) and optional `@ai-sdk/mcp@^2.0.73` (was
`^2.0.66`), the versions the library is tested against. Update both before the library.

### Behaviour changes

| Area | What changes | What to do |
|---|---|---|
| `respond()` with some pending ids | Used to reject with `EH_INVALID_INPUT` (`details.reason: 'incomplete'`). It now records the answers and ends at once with `stop: 'tool-pending'` and `TurnResult.partial: true`; the call that answers the last item continues the message. A call that answers nothing is still `'incomplete'`. | If you relied on the rejection to force a full answer, check `result.partial` (or compare ids) yourself. Spec 11 §4.3. |
| Pre-turn failures over HTTP | New and opt-in: `run.toHttpResponse()` answers a failure before the turn's commit point (busy in another instance, held lock, invalid input, no pending answer) with 409 / 400 / 503 and a JSON body. `run.toResponse()` and `handleChatRequest(...).toResponse()` are unchanged and still carry these failures in the stream (a `200`). `eharness/http` always uses the status form. | Switch your route to `await handleChatRequest(session, body).toHttpResponse()` and make the client read `{ error: { code, message } }` bodies, or mount `createHarnessHttp()`. |
| `memory_*` tools | `safe` in `DEFAULT_TOOL_KINDS` of `eharness/permissions`: no approval prompt for memory calls in any mode, plan mode included. The memory plugin confines paths to its own roots. | To keep prompting, give the tools a non-`safe` kind through the engine's `toolKinds`, or add `ask` rules naming them. |
| Tool error streak | `ERROR:` text results now count as failed results, and the new `loop.progress.toolErrorStreak` (default 8) stops a turn whose one tool keeps failing, even when other tools succeed in between (`W_LOOP_STUCK`, `details.kind: 'tool-errors'`). Turns that ran on before can now end with stop `'stuck'`. | Raise `toolErrorStreak` if a long retry loop is intended. Spec 05 §3.2. |
| Resume of a continuation | A resumed stream of a `respond()` continuation (`attach()`, `attachRemote()`, the stream log, `handleResumeRequest()`) starts with a replay of the continued message (`start` + rebuilt parts), and `from` counts those replay chunks. | Discard `from` cursors stored before the upgrade. `useChat` / `resumeStream()` and `readUIMessageStream` need no change; code that counts chunks by hand does. Spec 04 §6.3. |
| Session invariants | Every saved message is validated against AI SDK `UIMessage`. With `NODE_ENV` `test` or `development` (or `debug: { invariants: true }`) an invalid message throws `EH_INVALID_MESSAGE` and nothing is saved; otherwise `W_INVALID_MESSAGE` (`details.stage: 'save'`) and it is saved as is. On load, a message holding pending state or the active turn is kept with a warning, not dropped. | Fix producers of invalid messages (your tests will tell), or set `debug: { invariants: false }`. Spec 05 §15. |
| SSE keep-alive | The activity feed (and `eharness/http`) sends `: keep-alive` every 8 s. `Bun.serve` closes a connection after 10 s without bytes. | Set `idleTimeout: 0` on `Bun.serve` for chat streams ([HTTP server](http-server.md)). |
| Held wakes | A `wake` injection that arrives while approvals, client tool calls or external waits are pending is held in the durable inbox (when `storage.inbox` exists) and runs once in whichever instance resolves them; several wakes run as one turn. | Nothing; expect one wake turn where there used to be several. |
| `send()` order | A direct `send()` on an idle session with a durable inbox no longer overtakes older queued items; the drain applies them first. `session.stats()` on a cached idle handle re-reads `pending`, `activeTurn` and `usage` from storage. | Nothing; stats on a cached handle cost one storage read. |
| `output-denied` | Tool parts in `output-denied` always carry `approval.approved: false`; cold load repairs the old inconsistency (`W_REPAIRED_MESSAGE`). In `auto` mode a call a person approved is never classified again. | Nothing. |
| Auto classifier | `modelClassifier` sends `maxOutputTokens` (default 1024) and `temperature: 0`; a judge outage throws `ClassifierUnavailableError`, denies the call (`auto: 'unavailable'`) and no longer counts toward the repeated-blocks pause. | Pass `maxOutputTokens` / `temperature` to override; handle the `unavailable` auto event if you log decisions. |
| Compaction prompt | The default prompt tells the summarizer that the most recent messages are kept after its summary. | Update goldens that record the prompt. |
| `approvals: 'park'` subagents | `run_in_background` and `background.default` no longer throw: the child runs through its durable inbox and reports to the lead through storage. `data-subagent.run` is written for every park call; report events carry `data.turnId` and new `data.status` values `interrupted`, `timed_out`, `not_started`. A foreground park child whose parent call was cancelled now reports when it finishes. | Handle the new `status` values where you render report events; call `reconcileBackgroundChildren` at boot. |
| `ParentInfo` / `ChildSessionInfo` | Gain `agent`, `name`, `description` (older index entries still read). | Nothing. |
| New names | Hooks `message.saved` and `model.call`; warning codes `W_INVARIANT_VIOLATION`, `W_STREAM_LOG_FAILED`; `WarningCode` gains members. | Exhaustive `switch`es over `WarningCode` need cases. |
| Optional adapter additions | `InboxAdapter.enqueueOnce`, `InboxItemInput.dedupeKey`, `FileSystem.versions()` / `readVersion()`, `FileSystem.writeBytes(..., { mediaType })`, `storage.streams` (`StreamLogAdapter`). | Existing adapters keep working; implement them for the new features and run the conformance suites with `requireDedupe`, `requireVersions`, `keepsMediaType`. |

### New Draft subpaths

Each is Draft ([API stability](../engineering/api-stability.md#draft-modules-and-sections)) and may
change in a minor release. Migration means moving code your app already has onto them; nothing
breaks if you do not.

| Subpath | Replaces | Migration |
|---|---|---|
| `eharness/providers` | Hand-written provider settings, model lists and secret storage | `createProviderManager()` over a `ProfileStore` (`memoryProfileStore()` for tests; implement the port for a database). Use `manager.catalog()` as the agent's `models` option. [Providers and profiles](providers-and-profiles.md). |
| `eharness/connectors` | Per-app OAuth and MCP connection code | `createConnectorService()` and `activateConnectors()`; `ConnectionRecord` is new. [Connectors](connectors.md). |
| `eharness/activity` | A hand-rolled event log and SSE route | Add the `activity({ store })` plugin and serve `handleActivityStream()`; `listAttention()` / `answerAttention()` replace a custom approvals inbox. |
| `eharness/http` | The chat, sessions, attention and activity routes every server writes | Mount `createHarnessHttp(agent, { authorize })`; map your auth to `authorize`. Remove your copies of idempotency, stale-answer and busy handling. [HTTP server](http-server.md). |
| `eharness/client`, `eharness/client/react` | Browser glue around `useChat`, SSE and approvals | `createHarnessClient`, `createHarnessTransport`, `createChatSession`, `createActivityFeed`, `createAttentionList`. `SendOptions` of the client is named `ChatSendOptions`. [Web client](web-client.md). |

### Also new

- Core: `model.call` and `observeModel()`; `StreamLogAdapter` with `session.attachRemote()` and
  `handleResumeRequest()`; `session.recover()` and `recovery.instanceId`; `session.busy()`,
  `stats().usage`, `inputFiles.resolve`; `enqueue` `availableAt`, `id`, `metadata`;
  `agent.peek()`; `openRouterCatalog()`; `subagents({ maxChildren })`.
- `eharness/mcp`: `remoteMcpSource`, `bearerAuthProvider`, `listRemoteMcpTools`, and type-checking
  against `@ai-sdk/mcp` 2.0.7x.
- `eharness/testing`: `activityStoreConformance`, `httpConformance`, `multiInstanceConformance`,
  `streamLogConformance`, `profileStoreConformance`, the connector store suites,
  `scriptedProvider`, `schemaCheckedMessages`, `assertStoredSessionInvariants`.

## Upgrading to 0.7

0.7 adds six subpaths (`eharness/permissions`, `eharness/shell`, `eharness/subagent`,
`eharness/ask`, `eharness/web`, `eharness/filesystem/node`) and many session APIs. Nothing is removed,
but several defaults and model-visible texts change. Read the list below, then run your tests: every
item names what you will notice.

The peer dependencies are unchanged (`ai@^7.0.127`, `zod`, optional `@ai-sdk/mcp@^2.0.66`).

## Behaviour changes

| Area | What changes | What to do |
|---|---|---|
| `mcpServer` | Text parts of tool results (also of tools without `toModelOutput`) reach the model inside `<untrusted-content source="mcp" name="<server>/<tool>">…</untrusted-content>`. Images, structured JSON and `isError` are unchanged. | Add `UNTRUSTED_CONTENT_INSTRUCTIONS` to `instructions`. Opt out per server with `wrapUntrusted: false`. Update golden prompts. |
| `filesystem` tools | A `glob` tool is on by default (the tool list and the prompt-cache prefix change). | Pass `tools` without `'glob'` to keep the old list. |
| `filesystem` errors | Exceptions thrown by an adapter reach the model as `ERROR: <message>` (`classifyToolResult` says `'error'`) instead of `Error: …`. | `onAdapterError(error, { tool, path })` customises the text; returning `undefined` rethrows (the old behaviour). |
| `edit_file` | Accepts `edits: [{ old_string, new_string, replace_all? }]`; the single form still works. | Nothing, unless a test asserts the input schema. |
| Binary files | `list`, `stat` and `glob` show binary files; `read_file` shows images (and PDFs with `media: { pdf: true }`); other binaries answer an `ERROR:` text. | Custom `FileSystem` adapters may implement `readBytes` / `writeBytes`. |
| `session.stats()` | Measures the whole next request (skills index, turn-refresh instructions, skill and source tools), so `instructions` and `tools` can be larger. Deferred tools count 0. New `instructionBlocks` and `toolSources`. | Re-check thresholds built on `stats()`. |
| `PendingState.clientTools[]` | Entries gain `input` (and `inputTruncated: true` above 16 KB, then `input` is omitted). | Assertions with `toEqual` on these entries need the field. |
| `send(…, { ifBusy: 'steer' })` | When the running turn refuses the steer at once (its step loop ended, a manual `compact()` runs), the returned run is the queued turn's run, not an `attach()` of the running turn. | Use `run.delivery` (`'step' \| 'turn' \| 'dropped'`) to see what happened. |
| `core.children` state | State writes of an owner with a `setIf` adapter are compare-and-sets; on a conflict the write takes over `core.children`. The commit-point write no longer fails with `EH_SESSION_BUSY` when only a child registered meanwhile. | Make sure your `StateAdapter.setIf` is a real compare-and-set. |
| `respond()` stream | The continuation stream starts with one `tool-approval-response` chunk per consumed approval, between `start` and the first tool output. | Stream readers that rebuild messages (`readUIMessageStream`, `attach()`) now see answered calls leave `approval-requested` at once; `useChat` is unaffected. Update goldens. |
| `output-error` tool parts | A `rawInput` field is normalised to `input` before persisting, validating and projecting. | Nothing; AI SDK's `rawInput` deprecation warning goes away. |
| `eh.event`, `eh.compaction` | Projections escape the event name and neutralise `event`, `system-reminder`, `untrusted-content` (and `conversation-summary`) tags inside the text. | Nothing, unless you asserted the raw projected text. |
| New names | Hook `session.fork`; warning code `W_TOOL_ORDER`; `WarningCode` gains a member. | Exhaustive `switch`es over `WarningCode` need a case. |

`webFetch()` and `webSearch()` frame their output the same way (`source="web_fetch"`,
`source="web_search"`); they did not exist in 0.6, so there is nothing to migrate.

## New things worth adopting

- `session.fork()`, `children()`, `parentInfo()`, `session.tools()`, `compact({ keepLast, instructions })`,
  `toolOrder`, `deferTools`, `ctx.session.inject()`, `run.delivery`, `respond({ endTurn })` and
  approval notes: see the [reference](reference.md).
- `projectInstructions()` loads `CLAUDE.md` / `AGENTS.md` from the `fs` service (Draft).
- A coding agent: [filesystem](filesystem.md), [shell](shell.md), [permissions](permissions.md),
  [subagents](subagents.md), [ask](ask.md), [web](web.md), and the
  [coder example](../../examples/coder/README.md).

## Draft surfaces

These may change in a minor release ([API stability](../engineering/api-stability.md#draft-modules-and-sections)):
the `auto` permission mode and classifier, agent messaging (`send_message`, names, resume, roster),
the deferred-tools reminder format, the `<untrusted-content>` frame format and the
`projectInstructions()` frames and defaults.

## Known gaps

- The built-in `Read(.env*)` ask does not cover recursive directory reads, so a recursive `grep` or
  `find` through `bash` can read `.env` files without asking. Add `Read(**/.env*)` to `deny` or
  `ask`, and run `bash` in an OS sandbox ([permissions](permissions.md)).
- `webFetch()` cannot resolve DNS (it is runtime-neutral): without `resolveHost`, a public name that
  resolves to a private address is not refused (DNS-based SSRF). Inject a resolver on any server
  that fetches for untrusted users ([web](web.md)).
- The shell command analysis is a gate, not a sandbox.
