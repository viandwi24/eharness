# Upgrading

- [0.7 → 0.8](#upgrading-to-08)
- [0.6 → 0.7](#upgrading-to-07)

## Upgrading to 0.8

0.8 adds six Draft subpaths (`eharness/providers`, `eharness/connectors`, `eharness/activity`,
`eharness/http`, `eharness/client`, `eharness/client/react`), the subpath `eharness/web/node` and
many session APIs. It is a breaking release: public names are renamed (no deprecated aliases),
implementation helpers are no longer exported, and several defaults are stricter. Work through the
sections in this order; each item says what to do.

1. Update the peer dependencies: `ai@^7.0.137` (was `^7.0.127`) and optional `@ai-sdk/mcp@^2.0.73`
   (was `^2.0.66`), the versions the library is tested against. Update both before the library.
2. Apply the [rename table](#renamed-api-one-naming-convention) with a search and replace.
3. Fix imports of [removed exports](#removed-exports).
4. Go through the [breaking changes](#breaking-changes-by-area) and the
   [behaviour changes](#behaviour-changes), then run your tests.

### Renamed API (one naming convention)

Plugin factories are named like the plugin's runtime `name`; in-memory implementations use the
`inMemory` prefix; tool and skill sources end in `Source`; every plugin, source, adapter and store
factory takes one `options` object. Runtime plugin names do not change, so persisted plugin state
keeps working. There are no deprecated aliases. After the search and replace, move the leading
positional argument of the listed factories into the options object. `session.abort()` callers that
ignored the return value can keep doing so. Subpaths such as `eharness/storage/memory` keep their
paths.

| Old | New |
|---|---|
| `askUser`, `AskUserOptions` | `ask`, `AskOptions` |
| `approvalGuard`, `ApprovalGuardOptions` | `guard`, `GuardOptions` |
| `permissionsPlugin`, `PermissionsPluginOptions` | `permissions`, `PermissionsOptions` |
| `groupChat`, `GroupChatOptions`, `GroupChatPlugin` | `group`, `GroupOptions`, `GroupPlugin` |
| `subagents`, `SubagentsOptions` | `subagent`, `SubagentOptions` |
| `memoryFs`, `memoryMessages`, `memoryState`, `memoryInbox`, `memoryBudgetLedger`, `memoryStreamLog`, `memoryActivityStore`, `memoryCatalogCache`, `memoryCheckpointStore`, `memoryProfileStore`, `memoryConnectionStore`, `memoryCredentialStore`, `memoryEnablementStore`, `memoryFlowStore`, `memoryRefreshLock` (and their `Memory*Options` types) | the same names with the `inMemory` prefix (`inMemoryFs`, `InMemoryFsOptions`, ...) |
| `mcpServer`, `McpServerOptions` | `mcpServerSource`, `McpServerSourceOptions` |
| `openApiTools`, `OpenApiToolsOptions` | `openApiSource`, `OpenApiSourceOptions` |
| `diskFs(root, opts)` | `diskFs({ root, ...options })` |
| `nodeCheckpointStore(dir, opts)` | `nodeCheckpointStore({ dir, ...options })` |
| `localSandbox(root, opts)` | `localSandbox({ root, ...options })` |
| `fsSkillSource(fs, opts)` | `fsSkillSource({ fs, root, ... })` |
| `openApiTools(spec, opts)` | `openApiSource({ spec, ...options })` |
| `sealedProfileStore(inner, vault, opts)` | `sealedProfileStore({ inner, vault, ...options })` |
| `mountFs(mounts)` | `mountFs({ mounts })` (new type `MountFsOptions`) |
| `inMemoryFs(seed, opts)` | `inMemoryFs({ seed, ...options })` |
| `inMemoryProfileStore(initial)`, `inMemoryConnectionStore(initial)` | `inMemoryProfileStore({ initial })`, `inMemoryConnectionStore({ initial })` |
| `run.toResponse()` (stream at once, always 200) | `run.toStreamResponse()` |
| `run.toHttpResponse()` (waits for `accepted`, proper status) | `run.toResponse()` |
| `session.edit(messageId, input, options)` | `session.edit({ messageId, input, ...options })` |
| `session.abort()` (void, local) and `session.requestAbort()` | `session.abort()`: awaitable, returns `{ target }` (the old `requestAbort` semantics); `requestAbort` is removed |

### Removed exports

The public surface is trimmed to plugin factories and option types, ports and adapters, tool-name
constants, stored-text constants and documented helpers. The export list is a committed snapshot
(`scripts/exports.snapshot.json`) that CI checks. Instruction, nudge and preamble texts and
implementation helpers are internal now; override options (`instructions`, `reminder`, `preamble`,
`protocol`, `policy`) still work. If you imported a removed name, copy the few lines you need or
open an issue.

| Entry point | Removed |
|---|---|
| `eharness` | `FINAL_ANSWER_DESCRIPTION`, `MAX_STEPS_WRAP_UP`, `OUTPUT_INSTRUCTION`, `OUTPUT_RETRY`, `PAGE_CONTEXT_PREAMBLE`, `PROGRESS_NUDGE` (texts that appear in stored messages or tool results, such as `INTERRUPTED_*`, `DENIED_NEW_INPUT`, `WAIT_TIMED_OUT`, stay) |
| `eharness/activity` | `encodeActivityEvent`, `pruneBoundary` |
| `eharness/ask` | `ASK_DESCRIPTION`, `formatAnswers`, `parseQuestions` |
| `eharness/client` | `createSseParser`, `createStore`, `parseActivityEvent`; the `http` and `activity` type re-exports except documented aliases |
| `eharness/connectors` | `BUILTIN_TOOLS`, `DEFAULT_FLOW_TTL_MS`, `assertSecureUrl`, `buildAuthorizationUrl`, `connectorForm`, `defaultConnectionLabel`, the OAuth discovery and exchange helpers (`discoverAuthorizationServer`, `discoverProtectedResource`, `exchangeCode`, `generatePkce`, `generateState`, `pkceChallenge`, `pollDeviceToken`, `refreshTokens`, `registerClient`, `requestDeviceCode`, `resourceMetadataFromChallenge`), `flowStepsOf`, `resolveFlowDeps`, the vaults `plaintextVault` / `webCryptoVault` (use `eharness/providers`) |
| `eharness/filesystem` | `bytesToBase64`, `checkpointTurnKey`, `copyCheckpoints`, `defaultNestedInstructionsFrame`, `defaultProjectInstructionsFrame`, `imageDimensions` |
| `eharness/group` | `GROUP_HISTORY_PREAMBLE`, `GROUP_SPEAKER_PREFIX` |
| `eharness/guard` | `GUARD_DEFAULT_POLICY`, `GUARD_INSTRUCTIONS`, `GUARD_PROMPT`, `GUARD_TRUNCATED`, `canonicalJson`, `verdictKey` |
| `eharness/http` | `classifyChatBody`, `httpError`, `sanitizeChatBody`, `statusOfCode` |
| `eharness/mcp` | `MCP_AUTO_DEFER_THRESHOLD`, `remoteMcpTransport` |
| `eharness/memory` | `DEFAULT_MAX_FILE_CHARS`, `DEFAULT_MAX_PINNED_CHARS`, `MEMORY_FLUSH_PROMPT`, `MEMORY_PROTOCOL`, `PINNED_PREAMBLE` |
| `eharness/openapi` | `OPENAPI_AUTO_DEFER_THRESHOLD`, `riskFromMethod` |
| `eharness/permissions` | `AUTO_CLASSIFIER_INSTRUCTIONS`, `AUTO_MAX_CONSECUTIVE_BLOCKS`, `AUTO_MAX_TOTAL_BLOCKS`, `DEFAULT_ALIASES`, `DEFAULT_BUILTIN_ASK`, `DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS`, `READ_ONLY_COMMAND_NAMES`, `isGlobArg`, `isReadOnlySubcommand`, `matchBashSpec`, `parseCommand`, `readPathArguments`, `restrictiveForms` |
| `eharness/providers` | catalog constants and parsers (`DEFAULT_CATALOG_TIMEOUT_MS`, `DEFAULT_CATALOG_TTL_MS`, `GATEWAY_MODELS_DEV_PROVIDERS`, `MODELS_DEV_URL`, `OPENROUTER_MODELS_URL`, `loadCachedJson`, `parseModelsDevModels`, `parseOpenRouterModels`), `SEALED_KEY`, `endpointChanged`, `mergeSecretPatch`, `providerFormSpec`, `scrub`, `secretValuesOf`, `withLegacyVault` (moved to `examples/team`) |
| `eharness/shell` | `MAX_TASK_OUTPUT`, `SANDBOX_HINT`, `seatbeltProfile`, `wrapCommand` |
| `eharness/subagent` | `AGENT_MESSAGE_INSTRUCTIONS`, `AGENT_MESSAGE_MAX_CHARS`, `AGENT_NAME_PATTERN`, `AGENT_OUTPUT_PAGE_CHARS`, `AGENT_REPORT_MAX_CHARS`, `subagentWaitId` |
| `eharness/todos` | `TODOS_CONTINUE`, `TODOS_INSTRUCTION`, `TODOS_REMINDER` |
| `eharness/web` | `htmlToText`, `matchHost`; `isPrivateHost` moved to `eharness` (`import { isPrivateHost } from 'eharness'`) |

### Breaking changes by area

**Errors and types**

| What changes | What to do |
|---|---|
| `TurnResult.error` is `{ code: HarnessErrorCode \| HarnessNoticeCode; message; details? }` and `code` is always set (`EH_RUN_FAILED` when nothing more is known). `NoticePayload.code`, the stored `metadata.eharness.error.code` and the activity `turn-ended` error use the same union. | A comparison with a free string still works at runtime; a code outside the union is a compile error. |
| Public paths throw `HarnessError`, never a plain `Error` / `TypeError` (`inMemoryFs` seeds, `write` / `writeBytes` arguments, `mountFs` and path-prefix options, `agent.session('')`, `agent.peek('')`, `MessageAdapter.load` with both `fromId` and `beforeId`, `subagent({ approvals: 'inline' })` without `answer`, `wrapPlugin` overrides, skill-source contract checks). | Catch with `isHarnessError(error, code)` instead of `instanceof TypeError`. |
| A custom `SessionLock` rejects with `HarnessError('EH_SESSION_BUSY')` for contention. Any other rejection is a failing lock service: the turn ends with `EH_LOCK_UNAVAILABLE` (HTTP 503) and `session.recover()` returns `reason: 'lock-unavailable'`. | Reject with `EH_SESSION_BUSY` only for contention; run `lockConformance`. |
| `session.events()`: a reader more than 1 000 events behind is errored with `EH_EVENTS_OVERFLOW` (it used to end like a normal close). | Reopen the reader and resync from state. |
| `debug.invariants` is explicit only: `NODE_ENV` `test` / `development` no longer switches it on. Option values that were silently accepted (for example `streams.flushMs: 0`, a duration above one day) now throw `EH_CONFIG_INVALID` at boot (rules in the [reference](reference.md#defineharnessagentconfig)). | Enable invariants in your test setup with `debug: { invariants: true }`; fix option values that throw. |
| Every saved message is validated against AI SDK `UIMessage`; with `debug.invariants` an invalid one is `EH_INVALID_MESSAGE` and nothing is saved, otherwise `W_INVALID_MESSAGE` and it is saved. | Fix the producer of an invalid message (your tests will tell). `WarningCode` gains members: exhaustive `switch`es need cases. |

**Turn behaviour**

| What changes | What to do |
|---|---|
| Nothing the core awaits can hang a turn: awaited hooks are raced against the abort signal and `hooks.timeoutMs` (30 000, `W_HOOK_TIMEOUT`); model streams get idle timeouts (`settings.timeout`, 120 000 each) and `maxRetries: 2`; `mcpServerSource` connect and listing time out after `timeoutMs` (15 000, `EH_MCP_TIMEOUT`); tool sources are listed concurrently with a `toolSources.timeoutMs` limit. A failed tool source is no longer retried at every turn (`toolSources.retryAfterMs`, 5 000, doubling up to 60 000). An `input.submit` hook that throws blocks with the generic text `Input check failed.`. | `toolSources: { retryAfterMs: 0 }` retries at every turn again; `settings: { timeout: false }` turns the idle timeouts off. |
| `ERROR:` text tool results count as failures for the progress guard; the new `loop.progress.toolErrorStreak` (default 8) stops a turn whose one tool keeps failing. | Raise `toolErrorStreak` for an intended long retry loop. |
| `respond()` with only some of the pending ids records them and ends with `stop: 'tool-pending'` and `TurnResult.partial: true` (it used to reject with `EH_INVALID_INPUT`, `details.reason: 'incomplete'`). | Check `result.partial` if you relied on the rejection. |
| A resumed stream of a `respond()` continuation starts with a replay of the continued message, and `from` counts those chunks. | Discard stored `from` cursors; `useChat` needs no change. |
| Background subagent children (`'park'` mode) are bounded: `background.timeoutMs` defaults to one hour and `stopOnTimeout` to `true`. | `background: { timeoutMs: Number.POSITIVE_INFINITY, stopOnTimeout: false }` for the old behaviour. |

**Network, permissions and security defaults**

| What changes | What to do |
|---|---|
| `eharness/http` `authorize` fails closed: a result that is not a `Response`, a `{ deny }` or an object answers `401 EH_HTTP_UNAUTHORIZED` (so `authorize: ({ request }) => userOf(request)` denies anonymous callers). | Return an object principal for allowed callers; use `openAccess` for local development. |
| `eharness/http` accepts only `data:` URLs in client file parts. | `chat.allowFileUrls: true` (http / https) or a `(url: URL) => boolean` predicate. |
| `openApiSource` responses are framed with `untrustedContent()` (`<untrusted-content source="openapi">`); a successful JSON response is the compact JSON text inside the frame, not the parsed value. | `wrapUntrusted: false` keeps the parsed value; add `UNTRUSTED_CONTENT_INSTRUCTIONS` to `instructions`. |
| `mcpServerSource({ pinDefinitions })` defaults to `true` for remote servers (`type: 'http' \| 'sse'`) and stays `false` for stdio and `MCPTransport` instances. Structured (JSON) results and error messages of failed MCP calls are framed as untrusted content like text when `wrapUntrusted` is on. | `pinDefinitions: false` accepts every definition change of a remote server. |
| OAuth requests of `eharness/connectors` (discovery, registration, token, refresh, device) refuse private, loopback and link-local hosts and do not follow redirects to another origin (same-origin redirects: at most 3, re-validated). Response bodies are capped (`maxResponseBytes`, 1 MiB). | A local development server needs `oauth: { allowPrivateNetwork: true }` on `createConnectorService` / `FlowDeps` / `createCredentialManager`. |
| `localSandbox` no longer passes `process.env` to commands: only an allow-list (`SAFE_ENV_NAMES`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, plus Windows basics). `bash_output` `filter` and `notify_on` accept only the safe regex subset of the `grep` tool. | Add variables with `localSandbox({ root, env })`, or pass `inheritEnv: true` for the old behaviour. |
| `memory_*` tools are `safe` in `DEFAULT_TOOL_KINDS` of `eharness/permissions`: no approval prompt in any mode. | Give the tools a non-`safe` kind through `toolKinds`, or add `ask` rules naming them. |
| Approval guard: the verdict cache expires after 1 hour (`cache.ttlMs`); an input longer than `transcript.maxChars` is not judged (it asks a person); `modelClassifier` asks instead of judging an action over 2 000 / 4 000 characters; `AutoVerdict.decision` gains `'ask'`. | `cache: { ttlMs: Infinity }` restores the old cache; raise `transcript.maxChars`. |
| A session grant or a suggested rule never covers a high-risk flag (`--force`, `git push -f`, `--privileged`, `-v /...`, `--mount`, `rm -r` / `-f`, `--hard`); an `allow` rule with a wildcard no longer approves `python -c` / `node -e` / `perl -e` inline code (only an exact rule does). | Nothing; expect more prompts for these forms. |

### Behaviour changes

| Area | What changes | What to do |
|---|---|---|
| `respond()` with some pending ids | Used to reject with `EH_INVALID_INPUT` (`details.reason: 'incomplete'`). It now records the answers and ends at once with `stop: 'tool-pending'` and `TurnResult.partial: true`; the call that answers the last item continues the message. A call that answers nothing is still `'incomplete'`. | If you relied on the rejection to force a full answer, check `result.partial` (or compare ids) yourself. Spec 11 §4.3. |
| Pre-turn failures over HTTP | New and opt-in: `run.toResponse()` answers a failure before the turn's commit point (busy in another instance, held lock, invalid input, no pending answer) with 409 / 400 / 503 and a JSON body. `run.toStreamResponse()` and `handleChatRequest(...).toStreamResponse()` are unchanged and still carry these failures in the stream (a `200`). `eharness/http` always uses the status form. | Switch your route to `await handleChatRequest(session, body).toResponse()` and make the client read `{ error: { code, message } }` bodies, or mount `createHarnessHttp()`. |
| `memory_*` tools | `safe` in `DEFAULT_TOOL_KINDS` of `eharness/permissions`: no approval prompt for memory calls in any mode, plan mode included. The memory plugin confines paths to its own roots. | To keep prompting, give the tools a non-`safe` kind through the engine's `toolKinds`, or add `ask` rules naming them. |
| Tool error streak | `ERROR:` text results now count as failed results, and the new `loop.progress.toolErrorStreak` (default 8) stops a turn whose one tool keeps failing, even when other tools succeed in between (`W_LOOP_STUCK`, `details.kind: 'tool-errors'`). Turns that ran on before can now end with stop `'stuck'`. | Raise `toolErrorStreak` if a long retry loop is intended. Spec 05 §3.2. |
| Resume of a continuation | A resumed stream of a `respond()` continuation (`attach()`, `attachRemote()`, the stream log, `handleResumeRequest()`) starts with a replay of the continued message (`start` + rebuilt parts), and `from` counts those replay chunks. | Discard `from` cursors stored before the upgrade. `useChat` / `resumeStream()` and `readUIMessageStream` need no change; code that counts chunks by hand does. Spec 04 §6.3. |
| Session invariants | On load, a message holding pending state or the active turn is kept with a warning (`W_INVARIANT_VIOLATION`, `W_INVALID_MESSAGE`), not dropped. See the breaking change above for `debug.invariants`. | Nothing. In tests, enable `debug: { invariants: true }` yourself (a preload that wraps `defineHarnessAgent`). Spec 05 §15. |
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
| Secrets and endpoints | In `eharness/providers` and `eharness/connectors`, a patch that changes an endpoint field (a `z.url()` / `format: 'uri'` field or `ehMeta({ endpoint: true })`, for example `baseURL` or a custom MCP `url`) no longer keeps the stored secrets: they must be resent in the same patch or they are cleared (a required key fails with `EH_CONFIG_INVALID`); a connection also loses its OAuth credentials and goes to `needs-auth`. | Make forms that edit only the URL ask for the key again. Export `endpointChanged` is available for your own checks. |
| Permissions: case and dot-globs | Protected paths, the built-in `Read(.env*)` ask and user `deny` / `ask` rules match case-insensitively (NFC, trailing dots and spaces ignored) on every platform, so `.GIT/config` and `.ENV` now ask; a read-only command whose glob can expand to `..` (`ls .?/`, `ls -d .*`) no longer auto-approves. `allow` rules stay exact. | Nothing to change; expect more prompts for these forms. |
| Permissions: deny/ask see through wrappers | `deny` / `ask` shell rules also match after `sudo`, `env`, `sh -c '...'`, `/bin/rm`, git global options and similar, so `deny: ['Bash(rm:*)']` now denies `sudo rm x`. | Review rules that relied on the old narrower match. |
| Permissions: shell session grants | `remember: 'session'` on a shell approval stores the tool plus the command prefix (`git commit`), not the whole tool; wrappers, interpreters, compound commands, redirects and protected paths are never remembered. Old per-tool shell grants are ignored (the call asks again). New hook `tool.grantScope`. | Nothing to change; users are asked again once per prefix. |
| Custom MCP `read` capability | A custom remote MCP server's `read` capability now defaults to `ask` (its `readOnlyHint` is untrusted). Curated connectors keep their defaults. | Switch the mode to `allow` per enablement for servers you trust. |
| `web_fetch` private hosts | More private ranges are refused (trailing-dot names, NAT64, 6to4, Teredo, `100.64.0.0/10`, `198.18.0.0/15` and others). | Nothing to change; pass `resolveHost` to catch public names that resolve to private addresses. |
| `session.events()` and SSE backpressure | A reader that falls 1 000 events behind is closed instead of buffering; `activityStream` keeps a 512-frame queue and stops reading the store while a client is not reading. | Re-open the reader (and resync from state) when its stream ends early. |

### New Draft subpaths

Each is Draft ([API stability](../engineering/api-stability.md#draft-modules-and-sections)) and may
change in a minor release. Migration means moving code your app already has onto them; nothing
breaks if you do not.

| Subpath | Replaces | Migration |
|---|---|---|
| `eharness/providers` | Hand-written provider settings, model lists and secret storage | `createProviderManager()` over a `ProfileStore` (`inMemoryProfileStore()` for tests; implement the port for a database). Use `manager.catalog()` as the agent's `models` option. [Providers and profiles](providers-and-profiles.md). |
| `eharness/connectors` | Per-app OAuth and MCP connection code | `createConnectorService()` and `activateConnectors()`; `ConnectionRecord` is new. [Connectors](connectors.md). |
| `eharness/activity` | A hand-rolled event log and SSE route | Add the `activity({ store })` plugin and serve `handleActivityStream()`; `listAttention()` / `answerAttention()` replace a custom approvals inbox. |
| `eharness/http` | The chat, sessions, attention and activity routes every server writes | Mount `createHarnessHttp(agent, { authorize })`; map your auth to `authorize`. Remove your copies of idempotency, stale-answer and busy handling. [HTTP server](http-server.md). |
| `eharness/client`, `eharness/client/react` | Browser glue around `useChat`, SSE and approvals | `createHarnessClient`, `createHarnessTransport`, `createChatSession`, `createActivityFeed`, `createAttentionList`. `SendOptions` of the client is named `ChatSendOptions`. [Web client](web-client.md). |

### Also new

- Core: `config.observe(event)` (phase durations and counters, [observability](observability.md)),
  `hooks`, `toolSources` and `warnings` options, bounds checks on every numeric option, the shared
  `createJudge()` engine ([LLM judge](llm-judge.md)), `errorText()` and `isRecord()` helpers;
  `model.call` and `observeModel()`; `StreamLogAdapter` with `session.attachRemote()` and
  `handleResumeRequest()`; `session.recover()` and `recovery.instanceId`; `session.busy()`,
  `stats().usage`, `inputFiles.resolve`; `enqueue` `availableAt`, `id`, `metadata`;
  `agent.peek()`; `openRouterCatalog()`; `subagent({ maxChildren })`.
- `eharness/mcp`: `remoteMcpSource`, `bearerAuthProvider`, `listRemoteMcpTools`, and type-checking
  against `@ai-sdk/mcp` 2.0.7x.
- `eharness/web/node`: `nodeResolveHost`, a ready `resolveHost` for `webFetch`.
- `eharness/filesystem/node`: `nodeRealpath`; `eharness/filesystem`: `splitLines`,
  `statelessPattern` and `GREP_SCAN_CHARS` for adapter authors.
- `eharness/testing`: `activityStoreConformance`, `httpConformance`, `multiInstanceConformance`,
  `streamLogConformance`, `profileStoreConformance`, the connector store suites,
  `scriptedProvider`, `schemaCheckedMessages`, `assertStoredSessionInvariants`.

## Upgrading to 0.7

0.7 adds six subpaths (`eharness/permissions`, `eharness/shell`, `eharness/subagent`,
`eharness/ask`, `eharness/web`, `eharness/filesystem/node`) and many session APIs. Nothing is removed,
but several defaults and model-visible texts change. Read the list below, then run your tests: every
item names what you will notice.

The peer dependencies are unchanged (`ai@^7.0.127`, `zod`, optional `@ai-sdk/mcp@^2.0.66`).

### 0.7 behaviour changes

| Area | What changes | What to do |
|---|---|---|
| `mcpServerSource` | Text parts of tool results (also of tools without `toModelOutput`) reach the model inside `<untrusted-content source="mcp" name="<server>/<tool>">…</untrusted-content>`. Images, structured JSON and `isError` are unchanged. | Add `UNTRUSTED_CONTENT_INSTRUCTIONS` to `instructions`. Opt out per server with `wrapUntrusted: false`. Update golden prompts. |
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

### New things worth adopting from 0.7

- `session.fork()`, `children()`, `parentInfo()`, `session.tools()`, `compact({ keepLast, instructions })`,
  `toolOrder`, `deferTools`, `ctx.session.inject()`, `run.delivery`, `respond({ endTurn })` and
  approval notes: see the [reference](reference.md).
- `projectInstructions()` loads `CLAUDE.md` / `AGENTS.md` from the `fs` service (Draft).
- A coding agent: [filesystem](filesystem.md), [shell](shell.md), [permissions](permissions.md),
  [subagents](subagents.md), [ask](ask.md), [web](web.md), and the
  [coder example](../../examples/coder/README.md).

### Draft surfaces of 0.7

These may change in a minor release ([API stability](../engineering/api-stability.md#draft-modules-and-sections)):
the `auto` permission mode and classifier, agent messaging (`send_message`, names, resume, roster),
the deferred-tools reminder format, the `<untrusted-content>` frame format and the
`projectInstructions()` frames and defaults.

### Known gaps

- Without the permission engine's `containsProtected` option (`nodeContainsProtected` from
  `eharness/filesystem/node`) the built-in `Read(.env*)` ask does not cover recursive directory
  reads, so a recursive `grep` or `rg` through `bash` can read `.env` files without asking. Pass the
  option, add `Read(**/.env*)` to `deny` or `ask`, and run `bash` in an OS sandbox
  ([permissions](permissions.md)).
- `webFetch()` cannot resolve DNS (it is runtime-neutral): without `resolveHost`, a public name that
  resolves to a private address is not refused (DNS-based SSRF; `W_WEB_NO_RESOLVER` warns once per
  session). Pass `resolveHost: nodeResolveHost` from `eharness/web/node` on any server that fetches
  for untrusted users ([web](web.md)).
- The shell command analysis is a gate, not a sandbox.
