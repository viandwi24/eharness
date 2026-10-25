# eharness

## 0.9.0

### Minor Changes

- [`47a6aca`](https://github.com/viandwi24/eharness/commit/47a6acaef674a9c45251758019135deebca2dfd2) Thanks [@viandwi24](https://github.com/viandwi24)! - Attachments in practice. `subagent({ files: { resolve } })` adds an optional `files` argument to the `agent` tool: the references the model passes (paths or library refs) become file parts of the child's first user message, with readable `ERROR:` strings for a missing, oversize or unsupported file. `inputFiles.describe` adds a text note after each referenced file of a user message at projection time (for example its path), so the model can pass an attachment on. `ModelInfo.inputModalities` (read by `modelsDevCatalog` and `openRouterCatalog`) lets a turn refuse a new image, PDF, audio or video file the model cannot read before anything is stored, with `EH_INVALID_INPUT` (`details.reason: 'unsupported-modality'`) and a message naming the model and the fix; unknown modalities never block. Spec 05 now documents that a provider failure leaves an empty assistant message next to the `eh.notice` on purpose.

- [`0e306fe`](https://github.com/viandwi24/eharness/commit/0e306fef30d6ce012a873b41dc3911ca038c4c37) Thanks [@viandwi24](https://github.com/viandwi24)! - New `eharness/browser` (Draft) and `eharness/browser/node`: agents drive a real browser. A registry of adapters (`chromeAdapter`, `lightpandaAdapter`, each with manual and managed mode and its own settings form), browser profiles (`BrowserProfileStore`, `memoryBrowserProfileStore`, `sealedBrowserProfiles`, `publicProfile`), a manager with leases, idle release, takeover and live view (`createBrowserManager`), and the `browser()` plugin: accessibility snapshots with refs, acting on refs, screenshots as media references the model sees in its next step, `browser_request_human` that parks the turn, domain rules and untrusted-content framing. `eharness/browser/node` adds `chromeRuntime` and `lightpandaRuntime` (download, start, stop, memory and CPU usage). `eharness/testing` adds the fake CDP peer and `browserProfileStoreConformance`. `requestHuman` receives `sessionId`, `waitId`, `toolCallId` and `ctx`; `createBrowserManager({ systemMemory })` may be synchronous; both runtimes clear stale Chrome profile locks and kill an engine orphaned by a hard crash on `start`.

- [`fe58d2d`](https://github.com/viandwi24/eharness/commit/fe58d2ded0c869320ecfc544dbf18b75eaf7a115) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/browser: new read-risk tool `browser_scroll` (direction, amount or pages, scroll to a ref, optional wait), so scrolling a page no longer needs an approval; it is appended after the other tools and its risk can be overridden through `risk`. `browser_act` with `kind: 'scroll'` still works.

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - New Draft subpath `eharness/channels`: the platform-neutral delivery machinery for chat products. `createRateGovernor` (token buckets per call class and key, park state for "retry after N s", abortable `acquire`), `createOutbox` with the `OutboxStore` port (idempotent enqueue, leased claims, retry with exponential backoff and jitter, dead-letter, per-target circuit breaker) and `memoryOutboxStore`, and structured mentions (`mentionToken`, `parseMentionTokens`, `neutralizeHandles`) so a model can never ping by typing `@handle`. `outboxStoreConformance` lives in `src/testing/channels.conformance.ts` (barrel export pending). Spec 31.

- [`905f004`](https://github.com/viandwi24/eharness/commit/905f0040f54f9d471b2d05174e9640ea571a40c2) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/testing` gains `chaosStorage(inner, { seed, conflictRate, conflictPorts, delayMs, failRate })`, a deterministic fault-injecting wrapper for the message, state, inbox and lock ports (rev conflicts, lock contention, lost inbox claims, slow calls, failing `ack` / `release`, `expireLease`), so adapter authors can run their adapters and `multiInstanceConformance` under real-database conditions. `multiInstanceConformance` cases that let either instance run a queued turn or a wake now share one script, so a slow store cannot fail them.
  
  Fix: when an `InboxAdapter.ack` or `release` call failed, the item stayed claimed for as long as the instance lived (every claim of the same owner renews its own claims instead of returning them). The drain now retries failed acks and releases at its next run.

- [`a896860`](https://github.com/viandwi24/eharness/commit/a89686018c8011aed5c0f967f358770d4f2b0aed) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/http and eharness/client: `GET /sessions/:id/messages?clip=<chars>` replaces big tool `input`/`output` and data part `data` with a `{ eharnessClipped, chars, preview }` marker (read view only), `GET /sessions/:id/messages/:messageId` returns one full message, and the client gains `sessions.message`, `clip` on `sessions.messages` and `createChatSession`, `session.loadFull(messageId)` and `isClippedPart`.
  
  A long `reasoning` part is clipped too: it keeps a text preview, and its `providerMetadata` is replaced by `{ eharness: { clipped: true, chars } }` (`isClippedPart` is true for it).

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/clock: the `clock` plugin (a read-risk `datetime` tool with now, convert, add and diff over IANA zones) and pure zone helpers (`zonedParts`, `fromZoned`, `formatInZone`, `isValidTimeZone`, `addToMoment`, `diffMoments`) built on `Intl.DateTimeFormat`.

- [`f9b94d4`](https://github.com/viandwi24/eharness/commit/f9b94d4eb6d5c223abcc2b134298da0f294d5ed6) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/code` (Draft, spec 28, ADR-0061): `code()` lets an agent run Python over the files of the virtual file system. The file system stays the source of truth; the sandbox directory is a per-session cache synced incrementally before and after every run, with compare-and-set write-back (a file changed meanwhile is reported as a conflict instead of overwritten) and managed Python packages. The `filesystem()` plugin now provides a `filePolicy` service (`isHidden`, `isReadonly`, `extensionAllowed`, `isUndeletable`, built from the same options as the file tools) so sync honours the hidden, read-only, extension and undeletable rules; the `FilePolicy` type is exported. The built-in `files` connector gains optional code capabilities (`files: { code: true | { install: true } }`): `run` (`run_python`) and `install` (`install_packages`), `run` defaulting to `allow` (risk `write` on an isolated sandbox, `external` otherwise) and `install` to `ask`. The local shell sandbox also gains `denyRead` / `denyReadHome` / `allowRead` (read isolation), resource `limits` (CPU, file size, memory — `ulimit -v` on Linux, a sampled RSS watchdog elsewhere — and processes); file operations of `localSandbox` refuse symlinks and paths outside the root and `scratchSandbox` / `removeStaleScratch` (a disposable work directory per session). The OS sandbox is defence in depth; use a container or VM driver for hostile code.

- [`ad64ef7`](https://github.com/viandwi24/eharness/commit/ad64ef7e367740f51c660b6b7294b4fa32d95cae) Thanks [@viandwi24](https://github.com/viandwi24)! - Connectors for long-lived user sessions. `ConnectionCredentials.session` (`{ format, data }`) is an opaque credential slot a custom flow step can set (`scratch.credentials = { session }`); it is sealed with the other credentials and appears in no public view, flow state or log. New flow view `qr` (`url`, `expiresAt`, `pollIntervalMs`; the `url` may change under the same `viewId` while polling) and a `resend` flow action on `form` views for one-time codes. `ConnectorService.credentials(connectionId)` reads the stored credentials for trusted server code and `ConnectorService.markNeedsAuth(connectionId, message?)` lets a runtime mark a connection `needs-auth`. A connection with a session counts as `authorized`. Exports: types `QrView` and `ConnectionSession`. Spec 24 §2 and §4 updated.

- [`c5a86cc`](https://github.com/viandwi24/eharness/commit/c5a86cc40d4903f51d4f5d7992e8810c6ddfac72) Thanks [@viandwi24](https://github.com/viandwi24)! - Deprecate `eharness/group`, `eharness/guard` and `eharness/openapi` (ADR-0062): no product built on eharness uses them; they are removed at 1.0 unless one adopts them.

- [`73889f5`](https://github.com/viandwi24/eharness/commit/73889f59bea8014f4ffd322771b82b1bbc0e1a8e) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/handoff` (draft): `resolveHandoff` takes `output`, `resume` and `metadata`; a losing answer no longer re-delivers (use the new `redeliverHandoff` for crash recovery); `HandoffStore.answer` takes `extras.metadata`, applied in the same compare-and-set; new `startHandoff` building block for apps with their own `externalTool()`.

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - New module `eharness/handoff` (Draft): an agent hands a question or decision to a person and the turn parks on an external wait. `handoff({ store, notify })` registers the `ask_person` tool; `resolveHandoff`, `cancelHandoff` and `expireHandoffs` answer, cancel or expire a request from any instance and resume the same assistant message. Async `HandoffStore` port with compare-and-set answers, `memoryHandoffStore`, and the conformance suite `handoffStoreConformance` in `src/testing/handoff.conformance.ts`.

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - New module `eharness/identity` (Draft): one person with many platform accounts. `PersonStore` port (async) with `memoryPersonStore`, accounts keyed by platform and stable native id, audit events, hashed single-use pairing codes with `pairingGuard`, `resolveRole` (suspended or left means guest) and `decideByRisk`. Conformance suite `personStoreConformance` in `src/testing/identity.ts`.

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/limits: `stepBudget` (extend `loop.maxSteps` in chunks up to an app-defined cap, optional wrap-up reminder) and `budgetNotice` with `trackRefusals` (a readable `eh.notice` when the budget ledger stops a turn).

- [`e84ee50`](https://github.com/viandwi24/eharness/commit/e84ee50febf4cd633a09ed254016c19cd7121ffb) Thanks [@viandwi24](https://github.com/viandwi24)! - Long-run jobs. `longRun()` (`eharness/limits`) runs a job as a chain of bounded turns on the durable inbox: at the end of a chunk the model writes a checkpoint note, a continuation turn is enqueued with an idempotent id, and the job stops only when the model finishes, when it is stuck, when its cost or duration budget is spent or when `stop()` is called. Job state lives in the session state (`longRunState()`), `resume()` continues a running job after a restart. `stepBudget({ onCap })` gives a turn a few extra steps and a hand-over reminder when it reaches the hard cap while progressing. Core exports `LONG_RUN_CHECKPOINT_STOP` / `isLongRunCheckpoint`; background subagents do not report a checkpoint turn as the end of the child. State changes made by `turn.end` hooks are now written right after the hooks.

- [`ccfd787`](https://github.com/viandwi24/eharness/commit/ccfd787950c31bdf98950acb8508995efae47b0e) Thanks [@viandwi24](https://github.com/viandwi24)! - Channels (draft): the outbox gains `expiredLeases: 'retry' | 'hold'` (with `hold` an item whose lease
  expired is not resent but becomes `held`, emits `held`, and is resolved with `outbox.release(id,
  'retry' | 'drop')`), a terminal `skipped` state (`SkipSend`, `store.skip`), `openBreaker(target,
  untilMs, reason)`, a shared storm detector (`noteRateLimit(parkKey, retryAfterMs)`, `floods(key)`,
  `floodStorm.stormKey`, `RetryAfter({ counted })`), and function forms of `breaker.cooldownMs`,
  `floodStorm.count` and `floodStorm.windowMs`. `OutboxStore` gains `holdExpired`, `release` and `skip`,
  and `claim` takes `{ reclaimExpired }`; the conformance suite covers them. The rate governor gains
  `charge` (take tokens without waiting, the balance may go negative), `waitFor`, `resetBuckets`, an
  `acquire` `reserve` for patient callers, and classes that are a function of the key.

- [`44cbb66`](https://github.com/viandwi24/eharness/commit/44cbb66cf9a7ec036daabdec8f614126e9382cb0) Thanks [@viandwi24](https://github.com/viandwi24)! - Use the cost a provider reports: the settled cost of a step (budget ledger, `usage.costUsd`, `model.call` events) is the provider-billed cost when `providerMetadata` carries one (`openrouter.usage.cost`, gateway `cost`), else the catalog estimate. `model.call` events gain `costSource` and `upstreamProvider`. The OpenRouter provider enables usage accounting and gains optional routing settings (`providerOrder`, `allowFallbacks`, `stickyProvider`). New exports: `providerReportedCost`, `settledCostOf`, `CostSource`. `scriptedModel` steps accept `providerMetadata`.

- [`89bca99`](https://github.com/viandwi24/eharness/commit/89bca994d0e55aa664f5d58cf6e464d0962d3807) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/scheduler: cron, interval and one-shot schedules that fire into sessions across many instances (`createScheduler`, `ScheduleStore`, `memoryScheduleStore`, injected cron calculator, catch-up and overlap modes, deterministic fire ids) and `scheduleStoreConformance` for adapters.

- [`ccfd787`](https://github.com/viandwi24/eharness/commit/ccfd787950c31bdf98950acb8508995efae47b0e) Thanks [@viandwi24](https://github.com/viandwi24)! - Scheduler: `fire` may resolve to `{ fired: false }` (slot handled, nothing fired: `nextFireAt`
  advances, `lastFireAt` stays; reported as `skipped` with reason `declined`). `ScheduleStore` gains an
  optional compare-and-set `update(schedule, expectedVersion)`; `scheduler.update/pause/resume` use it
  with a retry loop so a concurrent fire and an edit no longer overwrite each other. The conformance
  suite covers it. Channels: the outbox detects flood storms (`floodStorm: { count, windowMs, scope }`,
  N `RetryAfter`s in a window open the breaker for the longest retry-after seen, per key or global) and
  emits `rate-limited` and `storm` events.

- [`ad64ef7`](https://github.com/viandwi24/eharness/commit/ad64ef7e367740f51c660b6b7294b4fa32d95cae) Thanks [@viandwi24](https://github.com/viandwi24)! - `subagent({ onPark })` and `subagentChild({ onPark })`: `'notice'` stores the "child waits for the user" notice of a parked durable background child without handing it to a running parent turn, so it never costs an extra model call; the final report still wakes the parent. The default `'step'` keeps today's behaviour (next-step delivery). Spec 20 §3.5.

- [`37c220e`](https://github.com/viandwi24/eharness/commit/37c220e6cbd9a5d2e9f03f43061223a81d5d6035) Thanks [@viandwi24](https://github.com/viandwi24)! - Media of MCP tool results (screenshots, audio) are written to the new `toolMedia` service of the filesystem plugin and stored as small `media-ref` parts instead of base64, so the message store does not grow with every screenshot. Projection and the live step read the bytes back (newest `toolOutput.keepImages` only); expired files become a note. New option `filesystem({ toolMedia })`, warning `W_TOOL_MEDIA_OFFLOAD`.
  
  `toolOutput.keepImages` also applies inside a running turn: a long turn of screenshots keeps only the newest in each step.
  
  Upgrade note: on by default for `filesystem()`. Stored messages now carry `media-ref` parts, which 0.8 cannot read back; do not roll an app back to 0.8 after it stored new tool media. Set `filesystem({ toolMedia: false })` to keep the old inline format.

### Patch Changes

- [`bc13c7e`](https://github.com/viandwi24/eharness/commit/bc13c7eef8390b8d0c04216333e68fe335f659d2) Thanks [@viandwi24](https://github.com/viandwi24)! - Internal: isolate the remaining `experimental_*` AI SDK options (`refineToolInput`, tool approval secret) behind one adapter file. No behaviour change.

- [`f19e97a`](https://github.com/viandwi24/eharness/commit/f19e97a8bfa2b298881d01e67f8335876fc32aaf) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/client`: the chat session now clears the AI SDK `Chat` error after `Chat` has set its status. `Chat` calls `onError` before it sets `status: 'error'`, so a clear inside the handler was a no-op and the composer stayed in the error state after a refused or already-answered send.

- [`2697161`](https://github.com/viandwi24/eharness/commit/26971616a0acaddf2b9c8991da0d86dc55b306da) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/client`: the chat transport also type-checks with newer `ai` releases, which declare `resumeStreamIsReplay` on `DefaultChatTransport` themselves. The value is set after construction instead of as a class field. No behaviour change.

- [`9931a0d`](https://github.com/viandwi24/eharness/commit/9931a0d45abc2dd72b971e0e419905824c892cec) Thanks [@viandwi24](https://github.com/viandwi24)! - Compaction now works with a large output reserve and with reasoning models. The effective `summarizeAt` is at most 95% of the guard's hard limit: with a 32k output cap on a 128k window the hard limit (82k) sat below `summarizeAt` (102k), so the guard trimmed every request while the summary never triggered. The summarizer call's `maxOutputTokens` is the agent's `settings.maxOutputTokens` (else `maxSummaryTokens + 12 000`) instead of `maxSummaryTokens`: reasoning models spent the 4 000-token limit on thinking, the summary was cut (`finishReason: 'length'`), and every compaction failed.

- [`9e56606`](https://github.com/viandwi24/eharness/commit/9e56606b88deb341cfca42aef871b7b1e291094b) Thanks [@viandwi24](https://github.com/viandwi24)! - `activateConnectors` keeps a connection whose status is `error` active (its tools stay; a call that cannot reach the server answers with a readable error). Only `needs-auth` and `disabled` connections are left out, so one failed health probe no longer takes an agent's tools away until the next test.

- [`07f9e43`](https://github.com/viandwi24/eharness/commit/07f9e43bf09b6a86d2035ba518277516c726c828) Thanks [@viandwi24](https://github.com/viandwi24)! - A call to a deferred tool that was not loaded yet now loads it for the next step (the failed call counts as a discovery), so the model does not need a separate `tool_search` round.

- [`64d837a`](https://github.com/viandwi24/eharness/commit/64d837a8bc57bbe7f8e6634a8edcf5d8061e72cc) Thanks [@viandwi24](https://github.com/viandwi24)! - `neutralizeHandles(text, allowed)` turns the `@handle` of people the app allowed for a post into a mention token where it is written; every other handle is still neutralized (`AllowedHandle`).

- [`a896860`](https://github.com/viandwi24/eharness/commit/a89686018c8011aed5c0f967f358770d4f2b0aed) Thanks [@viandwi24](https://github.com/viandwi24)! - Remove leaked tool-call markup (DeepSeek DSML and similar) from model text before it is streamed, persisted and projected; export `stripLeakedToolMarkup` for UIs.

- [`73a5cf3`](https://github.com/viandwi24/eharness/commit/73a5cf3430946f08968380f4b2864ae19dcd1544) Thanks [@viandwi24](https://github.com/viandwi24)! - `W_MCP_DRIFT` now carries `details.sessionId`, so an app can tell the owner which chat has tools excluded because their definitions changed on the MCP server.

- [`b0236ec`](https://github.com/viandwi24/eharness/commit/b0236ec58321761287f86feaf472e33ea7af6b7e) Thanks [@viandwi24](https://github.com/viandwi24)! - `mcpServerSource`: a tool call that fails because the session's MCP client was closed mid-turn (rebuilt agent, failed listing) now reconnects and retries once instead of failing for the rest of the turn. Mid-request `Connection closed` errors are never retried, and a client dropped after a failed listing is not closed while a call still runs on it.

- [`755d1ff`](https://github.com/viandwi24/eharness/commit/755d1ffb2b2d92619f9fbfea4176dc3ce6bac663) Thanks [@viandwi24](https://github.com/viandwi24)! - The remote MCP connector gets a `reviewToolChanges` setting (default off): a server's updated tools are used at once, and only a connection that asks to review keeps the definitions a chat first saw until accepted (`McpSourceSpec.pinDefinitions`, `remoteMcpSource({ pinDefinitions })`).

- [`60b5fb9`](https://github.com/viandwi24/eharness/commit/60b5fb94c8c37ddc0f62e2d060015240b3c09c25) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/shell` gains `probeOsSandbox()` (Draft): it runs a trivial command through the real bubblewrap or Seatbelt sandbox and returns `{ kind, ok, reason }`, so an application can tell "the tool is installed" from "the sandbox works on this host" (bubblewrap cannot create namespaces in many containers). `detectOsSandbox()` is unchanged.

- [`fbba611`](https://github.com/viandwi24/eharness/commit/fbba6119532e85d0c166ed514e1bea8cfa71474a) Thanks [@viandwi24](https://github.com/viandwi24)! - `remoteMcpSource({ refresh: 'turn' })` lists the server's tools before every turn instead of once per session, so a long-lived session sees tools the server added or changed.

- [`fcd5f6d`](https://github.com/viandwi24/eharness/commit/fcd5f6d1d6a7b622d33843fc4353d6b6c2c8f63d) Thanks [@viandwi24](https://github.com/viandwi24)! - Docs: every entry point now carries its stability label in the JSDoc of its `index.ts` (`**Stable:**`, `**Draft:**` with `@experimental`, `@deprecated` with the ADR), and every export of `eharness/group`, `eharness/guard` and `eharness/openapi` has `@deprecated` with its replacement ("removed in 1.0", ADR-0062). No runtime change. New guide `docs/guides/start-here.md` (which module do I need) and migration notes for the three deprecated modules.

- [`a00748c`](https://github.com/viandwi24/eharness/commit/a00748c91ad2acd079e2b60ba5b92f9c7c5ce287) Thanks [@viandwi24](https://github.com/viandwi24)! - `subagent({ childSessionId })` also receives the catalog key of the child (`agent`), so an app can tell its kinds of children apart by session id.

- [`fe58d2d`](https://github.com/viandwi24/eharness/commit/fe58d2ded0c869320ecfc544dbf18b75eaf7a115) Thanks [@viandwi24](https://github.com/viandwi24)! - eharness/subagent: a background subagent that ends after a stop request still reports its final answer to the parent (finished vs stopped is decided by whether its turn completed, and a stopped report carries the text so far), and `agent_stop` on an agent that already ended returns its final answer instead of only "not running".

- [`4e4b007`](https://github.com/viandwi24/eharness/commit/4e4b007b96af0b319bcbca237003c0c6f6ddd083) Thanks [@viandwi24](https://github.com/viandwi24)! - New `toolCalls.maxPerStep` (default 24): a step runs at most that many tool calls, and an exact repeat of a call in the same step does not run again; the model reads why. A degenerate step of hundreds of parallel calls no longer hammers a tool server.

- [`3c6534d`](https://github.com/viandwi24/eharness/commit/3c6534def0f855b9b1c0f0cfe689a17f76a1551c) Thanks [@viandwi24](https://github.com/viandwi24)! - Add `toolCalls.maxIdenticalResults` (default 3; 0 disables): within one turn, the same tool with the same input returning the same result or error text that many times is no longer run again and the model reads a refusal. Changing results (polling) stay allowed.

- [`1908981`](https://github.com/viandwi24/eharness/commit/1908981fec8a00f5199160b756162043464ea527) Thanks [@viandwi24](https://github.com/viandwi24)! - Repair tool input before the call: when a model sends a tool argument in the wrong type (an `object`/`array` as a JSON string, a number or boolean where only `string` is declared, a clean number string where `number`/`integer` is declared, per array item), the core converts it. For JSON Schema tools (MCP, OpenAPI) this happens before the call; for zod tools, which the AI SDK validates first, the core now supplies `repairToolCall` and retries an invalid input once repaired (too-long strings are left to the model; `config.repairToolCall` still runs after). Raises `W_TOOL_INPUT_REPAIRED` once per tool and property.

- [`f62acc1`](https://github.com/viandwi24/eharness/commit/f62acc156508d2093cb727128e96db1743d75087) Thanks [@viandwi24](https://github.com/viandwi24)! - An offloaded tool image is followed by a text part with its file path, so the model can send it on (a screenshot uploaded to a chat). A `refresh: 'turn'` tool source keeps its last good list when a listing fails, so its tools no longer come and go.

- [`fc116b2`](https://github.com/viandwi24/eharness/commit/fc116b2a5499846f24fb1600d6ee5edd1262eb30) Thanks [@viandwi24](https://github.com/viandwi24)! - Tool output limits no longer count or cut the base64 media of an MCP result (a screenshot used to reach the model as truncated base64 text); only its text parts are shortened. New `toolOutput.keepImages`: the model sees the newest N media items of tool results, older ones become a short note, and a model that cannot take images gets the refusal note instead of tool images.

- [`60b5fb9`](https://github.com/viandwi24/eharness/commit/60b5fb94c8c37ddc0f62e2d060015240b3c09c25) Thanks [@viandwi24](https://github.com/viandwi24)! - `tool_search` understands `select:<name>`, says why a name cannot be loaded (new optional `ToolSourceDef.explain`) and stops repeated identical searches. A call to an unloaded or unknown tool gets a short readable error instead of the list of every available tool. `grep` accepts a leading inline flag group (`(?i)`, `(?s)`, `(?m)`) and hints at other unsupported syntax.

- [`f17dfca`](https://github.com/viandwi24/eharness/commit/f17dfca5646ebd260f8a2fc008b858b5eaffc8b1) Thanks [@viandwi24](https://github.com/viandwi24)! - `NoticePayload.code` accepts app-defined strings (library codes still autocomplete), so `session.inject('eh.notice', { code: 'MY_CODE', ... })` type-checks without a cast. The showcase apps no longer cast `HarnessAgent` / `HarnessSession`: the agent and session generics already flow.

- [`60b5fb9`](https://github.com/viandwi24/eharness/commit/60b5fb94c8c37ddc0f62e2d060015240b3c09c25) Thanks [@viandwi24](https://github.com/viandwi24)! - The text that stands in for a file the current model cannot take now tells the model what to do: say in one sentence that it cannot see that kind of file with the current model, ask the person to describe it or switch model, and not try OCR or other workarounds.

- [`302927c`](https://github.com/viandwi24/eharness/commit/302927c005887c24ca25c419e0eb4f890fb4bb00) Thanks [@viandwi24](https://github.com/viandwi24)! - A file the model cannot take no longer breaks a session. Projection replaces a stored file part whose modality the current model lacks (`ModelInfo.inputModalities` known) with a short text note, for `data:` URLs and library references and for steers, without changing storage, so a session recovers after a model switch and an old image cannot fail every later turn. Input nobody waits on (`enqueue`, including `collect`, and steers) is accepted whole instead of being refused or failing at the provider: the text is kept and the model sees the note. `send()` and `edit()` still refuse a new unsupported file with `EH_INVALID_INPUT`.
  
  Text-like attachments (`text/*`, JSON, XML, YAML) with known bytes are now projected as text parts (a header line with name, type and size, then the content, cut at 100 000 characters) instead of file parts, which some upstreams reject.

## 0.8.0

### Minor Changes

- [`cff5252`](https://github.com/viandwi24/eharness/commit/cff525237234e5f00ce946ee6ee2026697717749) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/activity` (spec 25, ADR-0058), lifted from the team example. The **session activity feed**: the `activity({ store })` plugin turns session lifecycle hooks into events (`turn-started` with its source, `step-finished`, `turn-ended`, `pending-changed`, `approval-decided`, `message-saved`, `child-reported`, `session-recovered`, `compaction`); the `ActivityStore` port (append with a strictly increasing `seq`, read after a cursor, prune by age / count with a monotonic `prunedThrough`, free-form event types so apps share the feed) with `inMemoryActivityStore()` and `activityStoreConformance` in `eharness/testing`; SSE helpers on Web APIs only (`activityStream`, `handleActivityStream`, `readActivityPage`: initial flush, `boot` event, a `: keep-alive` comment every 8 s by default (below Bun's 10 s idle timeout; set `idleTimeout: 0` for chat streams), `id:` = seq, `Last-Event-ID`, `resync` for a cursor behind the prune mark or ahead of the head). The **attention queue**: `listAttention` (approvals, client-tool questions and optional external waits across a parent and its children, with routing info) and an idempotent `answerAttention` (`resumed | recorded | already-answered | not-found`, routed to the owning session, from any instance).
  
  Core: new observe-only hook `message.saved` (after `MessageAdapter.save` succeeded).

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Nothing the core awaits can hang a turn forever. Every awaited plugin hook is raced against the turn abort signal and `hooks.timeoutMs` (default 30 000; `W_HOOK_TIMEOUT`, `input.submit` stays fail-closed, `tool.approve` still denies); model streams get a default idle timeout (`settings.timeout` `firstChunkMs`/`chunkMs` 120 000, `timeout: false` turns it off) and an explicit `maxRetries` of 2; `mcpServerSource` connect and tool listing time out after `timeoutMs` (default 15 000, `EH_MCP_TIMEOUT`); tool sources are listed concurrently with a `toolSources.timeoutMs` limit and a backoff for failed sources (`toolSources.retryAfterMs`); every OAuth token, refresh, registration and discovery request has a default 15 000 ms limit. **BREAKING:** a failed tool source is no longer retried at every turn (set `toolSources: { retryAfterMs: 0 }` for the old behaviour); an `input.submit` hook that throws now blocks with the generic text `Input check failed.` instead of the error message. The default logger prints errors as name, message, code, status and cause only (no request bodies, headers or URL queries). Tests now fail on `W_INVARIANT_VIOLATION`.

- [`7b945f5`](https://github.com/viandwi24/eharness/commit/7b945f5edc7df7adae96dbd22ed7cfac0baca474) Thanks [@viandwi24](https://github.com/viandwi24)! - Status of pre-start failures and cheaper uploads: New `run.accepted` and `run.toResponse()` (the safe HTTP answer; `run.toStreamResponse()` streams at once and keeps these failures in the stream) answer failures before a turn's commit point (busy in this or another instance, a held `SessionLock`, invalid input, no pending answer) with 409 / 400 / 503 and a JSON body, while failures after the stream started stay in-stream; `session.busy()` reports a local or remote running turn with the `recovery.staleMs` check built in; `session.stats().usage` exposes cumulative tokens, turns and `costUsd`; `inputFiles.resolve(url, ctx)` resolves stored file references (a custom protocol) for the model at projection time; `FileSystem.writeBytes(path, bytes, { mediaType })` lets adapters keep the declared media type (`inMemoryFs` does; `fileSystemConformance({ keepsMediaType })`). See spec 03 §6, 04 §7.1, 05 §2, 08 §12.
  
  A run that waits before it starts (queued, `ifBusy: 'wait'`, or held behind an inbox drain) carries the `accepted` of the turn it becomes, so `toResponse()` answers `409` for a lock held by another instance (spec 04 §7.1, ADR-0059).

- [`47f1f9a`](https://github.com/viandwi24/eharness/commit/47f1f9af0d3eb8100dff43c32d321bb596a30c37) Thanks [@viandwi24](https://github.com/viandwi24)! - Gaps found by the team example. `agent.peek(sessionId)` is a side-effect-free read handle (messages, stats, busy, pending state, children, parent) that runs no `session.start` hook, recovery or reconcile (spec 05 §2.2). `ParentInfo` / `ChildSessionInfo` carry the child's `agent`, `name` and `description` (index entries without them still read), also returned by `pendingSubagentApprovals`. `subagent({ childSession, parentSession })` and `subagentChild({ parentSession })` pass session options (`lock`, `runtime`, `storage`) to the sessions the plugin opens, and `subagent({ maxChildren })` caps the children a session may start. The plugin's own reads of child and parent sessions now use `peek`. See spec 20 §2.3–2.4.

- [`1f73f3d`](https://github.com/viandwi24/eharness/commit/1f73f3d043ee9f9a82cd33240e952c39c7102c29) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpaths `eharness/client` and `eharness/client/react` (spec 27, ADR-0059; Draft), the browser counterpart of `eharness/http`, lifted from the team example's web app. `createHarnessClient` is a typed `fetch` client of the routes (`HarnessHttpError` with `isAlreadyAnswered` / `isBusy` / `isDuplicate`); `createHarnessTransport` builds on AI SDK's `DefaultChatTransport` (last message only, `Idempotency-Key`, `202` as an empty stream plus `onQueued`, a duplicate of an active turn resumes it, replaying resume); `createChatSession` is the framework-neutral logic around a chat (history paging, follow a running turn with retry, steer while busy, stalled-connection check, interrupted-turn Continue/Retry, error wording) driving a `ChatBridge` that `@ai-sdk/svelte` `Chat` satisfies and `@ai-sdk/react` `useChat` satisfies through `chatBridgeOf`; `createActivityFeed` is an SSE reader with reconnect, `Last-Event-ID`, idle watchdog, health pings that detect a restarted server (boot id), polling fallback and dedupe; `createAttentionList` is an optimistic approvals inbox with a generation guard, generic over the item (`AttentionList<Item, Answer>`), with a `list` source (an app's enriched view instead of `GET /attention`), `events` (the activity types that refetch; `ATTENTION_EVENTS` is the default) and app-defined answer kinds (`parseAnswer`) without casts; `followSessionStream(client, sessionId, { signal, onMessage, onChunk, onError })` is a read-only follower of the active turn of a session this tab did not start (AI SDK transport and `readUIMessageStream`). `headers` may be a function returning a record with `undefined` values (dropped); every JSON call takes `init` (`cache`, `keepalive`, ...) and `health()` is always `cache: 'no-store'`. Stores follow the Svelte store contract and work with `useSyncExternalStore`. `eharness/client/react` takes React by injection (`createReactBindings(React)`), no peer dependency. The client imports only `ai` at runtime; `check:imports` and a post-build check (`scripts/check-client-bundle.ts`, part of `check:package`) enforce it.

- [`bfa119f`](https://github.com/viandwi24/eharness/commit/bfa119f80465a5a1d57d632fba8e03c249f3d594) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/connectors` (spec 24, ADR-0049..0052; Draft): connector definitions (with optional display metadata `publisher`, `homepage`, `docsUrl`; `toolPrefix: 'always' | 'multiple' | 'never'` controls the connection-slug tool prefix), connections (workspace or agent scope, stored as `ConfigProfile` rows of kind `connection` with OAuth credentials in a separate row; `ConnectionRecord.slug` is an optional stable tool-prefix slug, so renaming a connection never renames its tools), per-agent enablement with capability modes (`allow | ask | off`) and per-tool overrides, a server-driven setup flow engine with a closed view vocabulary (`startFlow`, `advanceFlow`, `completeOAuth`, stale-view guard, sealed scratch; `FlowStepContext.label` titles the OAuth and device-code views with the connection's label), OAuth 2.1 helpers (PKCE, RFC 9728 / 8414 discovery, dynamic client registration, code exchange, refresh under a lock, device grant; `clientConfig(definitionId, flow)` receives the asking flow and the connection's `settings`, for per-connection OAuth clients), `activateConnectors` (stable plugin order, tool prefixes for several connections, permission rules with pinned asks that bypass mode cannot skip), `createConnectorService`, built-in connectors for the shipped plugins (`builtinConnectors`, `ensureBuiltinConnections`) and a custom remote MCP connector (`remoteMcpConnector`). It builds on the `SecretVault` of `eharness/providers`. `eharness/mcp` gains `remoteMcpSource` (fresh bearer per request), `bearerAuthProvider` and `listRemoteMcpTools`. `eharness/testing` adds `connectionStoreConformance`, `credentialStoreConformance`, `enablementStoreConformance` and `flowStoreConformance`.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Internal restructuring of the core with no behaviour change: the runtime import cycles between core
  folders are gone (hook running, token estimates, text truncation and model call observation moved
  to the layer that owns them, and `bun run check:imports` now fails on a new cycle), the turn
  lifecycle, the session handle and the step loop are split into phase functions over one explicit
  state object, and the shared `errorText(error)` and `isRecord(value)` helpers are exported for
  plugins and subpath modules.

- [`94cf82f`](https://github.com/viandwi24/eharness/commit/94cf82f4a7cc6b09e80c82f13a97c5f1277dd825) Thanks [@viandwi24](https://github.com/viandwi24)! - Durable background subagents in `approvals: 'park'` mode (ADR-0046). `subagent({ approvals: 'park', background })` no longer throws: `run_in_background: true` (or `background.default`) starts the child through its durable inbox and answers the parent's call at once, so the lead stays free to chat and a new user message no longer cancels the delegation. The child's report (and a status event when it waits for a person) reaches the lead as an `eh.event` through storage, from whichever instance finishes the child. `data-subagent.run` is now written for every park call (with the child session id, `background` flag), `agent_output` / `agent_stop` / `send_message` work on these children, `maxConcurrent` is counted from the stored child index, and `subagentChild()` gains `maxReportChars` / `outputToolName`. See spec 20 §3.5.

- [`140bcf7`](https://github.com/viandwi24/eharness/commit/140bcf7ce95a66cc2826557a17a33b00433e5c72) Thanks [@viandwi24](https://github.com/viandwi24)! - `ctx.turn.source` and `metadata.eharness.inboxKey` expose the caller id (`enqueue(…, { id })`) and inbox item ids to a turn made from the inbox, so hooks can match a turn to its producer without waiting for `enqueue()` to return. `enqueue(…, { metadata })` stores trusted app metadata as `metadata.app` of the user message (16 KiB cap; it wins over a client `app` key). `FileSystem` gains the optional `versions()` / `readVersion()` (and an `author` hint on writes); `inMemoryFs` implements them (`maxVersions`) and `fileSystemConformance` checks them with `requireVersions`. See ADR-0043.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `eharness/http` `authorize` now fails closed. A result that is not a `Response`, a `{ deny }` or an object (`undefined`, `null`, a string, an array) is answered with `401 EH_HTTP_UNAUTHORIZED` instead of running the route with an empty principal, so `authorize: ({ request }) => userOf(request)` denies anonymous callers. Migration: return an object principal for allowed callers; use `openAccess` for local development.

- [`1f73f3d`](https://github.com/viandwi24/eharness/commit/1f73f3d043ee9f9a82cd33240e952c39c7102c29) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/http` (spec 26, ADR-0059; Draft), lifted from the team example: `createHarnessHttp(agent, { authorize, ... })` returns a `fetch(Request): Promise<Response>` handler (Web APIs only) with the routes every harness server rewrites. **Chat** (`POST /sessions/:id/chat`: a `useChat` endpoint on `handleChatRequest` with a strict body whitelist, idempotency by message id or `Idempotency-Key`, stale-answer `409`, busy policies `reject` / `wait` / `steer` with `202` for a turn of another instance and `409 EH_SESSION_BUSY` for a turn on another instance with `ifBusy=reject`, respond, regenerate and edit; `GET /sessions/:id/chat/stream` resume; `POST /sessions/:id/interrupt`), **sessions** (snapshot, paged messages, optional list), the **attention** queue (`GET /attention`, `POST /attention/:id/answer` with ownership checks), and the **activity** feed (SSE and paged, filtered per principal). One required `authorize` hook runs before any body is read or session opened; every error has the shape `{ error: { code, message, details? } }` with a documented status table.
  
  Hooks: `chat.validate` (after the body was sanitised; may deny or return a normalised `{ body }`), `attention.decorate` (adds `item.extra` to `GET /attention`, `null` hides an item; wire type `AttentionItemWire`), `attention.parseAnswer` (receives `defaultParse()`, may return `undefined` to fall back to the whitelist: `maxNoteChars`, `allowRemember`), `attention.agentId` (a string or a function of the session id) and `attention.onSettled` (runs when the continuation of a `resumed` answer ends).
  
  Also exports the wire types, `sanitizeChatBody`, `httpError` and `openAccess` (development only), and `httpConformance` in `eharness/testing`. Bun closes a connection after 10 s without bytes by default: set `idleTimeout: 0` on `Bun.serve` for chat streams (see the HTTP guide).

- [`84f8bc9`](https://github.com/viandwi24/eharness/commit/84f8bc9d7b89714ca1ce8ad8f3418e990e4d0534) Thanks [@viandwi24](https://github.com/viandwi24)! - `session.enqueue()` gains `availableAt` (a durable timer on the inbox) and `id` (a caller-supplied idempotency key per session; a repeat returns `{ duplicate: true }` and stores nothing, also after the item was processed, within a 24 hour dedupe horizon). `InboxAdapter` gains the optional `enqueueOnce` and `InboxItemInput.dedupeKey`; `inMemoryInbox()` implements them (`dedupeWindowMs`), and `inboxAdapterConformance` checks them with `requireDedupe`. See ADR-0040 and spec 05 §12 rule 17.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Two permissions/judge changes.
  
  **Recursive reads (`eharness/permissions`, `eharness/filesystem/node`).** New optional engine option `containsProtected(realDir, patterns)` and a Node implementation `nodeContainsProtected` (bounded breadth-first walk: 32 levels, 50 000 entries, 2 s; fail closed; never follows symlinks). With it, `decideAsync` looks into every directory a command reads recursively (`grep -r/-R`, `rg`, `ag`/`ack`, `find -exec`, `cp -r`, `rsync -r`, `tar`, `zip -r`) and asks when a built-in ask path (`.env*`) or protected path (`.git` by default) is below it, or denies when a `Read` deny rule matches there. Without the option behaviour is unchanged (lexical). Wire it next to `realpath: nodeRealpath`. With the default `protectedPaths`, a recursive `grep -r` from a repository root now asks when the option is set.
  
  **One judge input limit (breaking, Draft).** `guard()` and `modelClassifier()` now both expose `maxCallChars`, the longest call input that is judged (longer asks a person), with one default, `DEFAULT_JUDGE_MAX_CALL_CHARS` = 8 000 (new core export; the judge's own default moves from 4 000 to it). Transcript limits stay separate (`transcript.maxChars` / `maxContext.maxChars`). Behaviour changes: the guard no longer takes the call limit from `transcript.maxChars` (it was 12 000 by default; set `maxCallChars: 12_000` to keep it), and `modelClassifier()`'s fixed 4 000 becomes 8 000 and configurable.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Permission engine and sandbox hardening (K-09). **BREAKING:** `AutoVerdict.decision` gains `'ask'` (a classifier that returns it hands the action to a person; custom classifiers need no change). **BREAKING:** the approval guard's verdict cache now expires after 1 hour by default (`cache.ttlMs`, `Infinity` restores the old behaviour); an input longer than `transcript.maxChars` is no longer judged (it asks a person), and `modelClassifier` asks instead of judging an action over 2000/4000 characters (migration: raise `transcript.maxChars`). **BREAKING:** a session grant or suggested rule never covers a high-risk flag (`--force`, `git push -f`, `--privileged`, `-v /…`, `--mount`, `rm -r/-f`, `--hard`…): such commands ask again; an allow rule with a wildcard no longer approves `python -c` / `node -e` / `perl -e` style inline code (only an exact rule does). New engine option `realpath` (with `nodeRealpath` from `eharness/filesystem/node`): protected paths and Read/Edit rules also match the symlink-resolved path (`g -> .git`, `x -> .env`). Deny rules now see through `xargs [flags]`, `find -exec`, `busybox`, `setsid` and `flock`. The bubblewrap sandbox adds `--unshare-pid --unshare-ipc --new-session`. `diskFs` opens files with `O_NOFOLLOW` and re-checks containment after the open; `nodeCheckpointStore` rejects traversal session ids (`..`).

- [`8cd8cf6`](https://github.com/viandwi24/eharness/commit/8cd8cf6afa032b8cf396760f04c2fabfb1586422) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/testing` adds `lockConformance(factory, options?)`: runner-agnostic cases for a `SessionLock` (acquire / release, prompt rejection while held, idempotent release that never frees a newer holder, one winner among parallel acquires, exclusion across a `peer` handle, takeover of an expired lease via `expire`). `httpConformance` gains a `sessionId` option for apps that only serve sessions they know, and `connectionStoreConformance` accepts the `source: 'store'` field a profile-backed store adds.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `mcpServerSource({ pinDefinitions })` now defaults to `true` for remote servers (`transport` config with `type: 'http' | 'sse'`, also when a resolver returns one) and stays `false` for stdio and `MCPTransport` instances. Migration: pass `pinDefinitions: false` to keep accepting every definition change of a remote server. Structured (JSON) tool output is now serialized and framed as untrusted content like text results when `wrapUntrusted` is on, and so are the error messages of failed MCP tool calls (the `error-text` the model sees), since server-provided text is untrusted either way.

- [`220d467`](https://github.com/viandwi24/eharness/commit/220d467f253d3b94d775d8f96b73cffe92deb753) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING (security default):** `eharness/permissions`: the `memory_*` tools are `safe` in `DEFAULT_TOOL_KINDS` (no more asking for every memory call). `eharness/filesystem` exports `splitLines`, `statelessPattern` and `GREP_SCAN_CHARS` for adapter authors; docs cover the conformance factory contract and the cost of an inbox without `notify`/`subscribe`.
  
  Migration: the `memory_*` tools no longer ask for approval under the permission engine. To keep asking, give the tools you want gated a non-`safe` kind through the engine's `toolKinds` option, or add `ask` rules naming them.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/testing`: `messageAdapterConformance` gains three cases (concurrent saves of one id end with one row, concurrent disjoint batches are all visible in id order, ids sharing a millisecond prefix keep a deterministic order). Third-party message adapters may now fail them; make `save` an atomic upsert and order by id.

- [`febec7d`](https://github.com/viandwi24/eharness/commit/febec7d1609fba554d7921a74dcae4dc9720cec9) Thanks [@viandwi24](https://github.com/viandwi24)! - New `model.call` plugin hook (observe-only) that fires after every model call of a session — turn steps, the compaction summarizer, the pre-compaction flush and calls routed through the new `ctx.observeModel()` — with the call options, the raw request body, response headers, the assembled output, usage, cost, finish reason and timings (`ModelCallEvent`). Implemented with an AI SDK language model middleware; nothing is wrapped when no plugin listens. New public helper `observeModel(model, report)`, `modelClassifier({ onModelCall })`, and `scriptedModel` steps accept `requestBody` / `responseHeaders`. See ADR-0047 and spec 12 §7.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Network defaults hardening (K-08). New Node-only subpath `eharness/web/node` with `nodeResolveHost` (a ready `resolveHost` for `webFetch`, `dns.lookup` with all addresses); `webFetch()` created without `resolveHost` (and without `onlyAllowed`) emits the new `W_WEB_NO_RESOLVER` warning once per session, and the web guide documents DNS rebinding and a pinned-IP `fetch` recipe. **BREAKING:** `openApiSource` responses are framed with `untrustedContent()` by default (`<untrusted-content source="openapi">`, like MCP text): a successful JSON response is now the compact JSON text inside the frame instead of the parsed value. Migration: pass `wrapUntrusted: false` to keep the parsed value. **BREAKING:** `eharness/http` accepts only `data:` URLs in client file parts by default (SSRF through server-side downloads); migration: `chat.allowFileUrls: true` (http/https) or a `(url: URL) => boolean` predicate. The provider catalog loader validates the shape per source (models.dev, OpenRouter), never overwrites a valid cache with an empty or invalid document, caps the body (`maxBytes`, default 16 MiB) and reports failures through the new `onWarning(message)` option; the client SSE parser drops lines over 1 MiB and events over 4 MiB of data.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** OAuth requests of `eharness/connectors` (discovery, registration, token, refresh, device) now refuse private, loopback and link-local hosts, including discovered endpoints, and no longer follow redirects to another origin (`redirect: 'manual'`; same-origin redirects are followed at most 3 times and re-validated). Migration: for a local development server pass `oauth: { allowPrivateNetwork: true }` to `createConnectorService` / `FlowDeps` / `createCredentialManager` (or `allowPrivateNetwork` / `isAllowedUrl` to the helpers). `assertSecureUrl` applies the same check. OAuth response bodies are capped (`maxResponseBytes`, default 1 MiB). `isPrivateHost` is now exported from the core entry (shared with `web_fetch`).
  
  Connectors: flows can be bound to a principal (`startFlow` / `startConnect` / `reconnect` `principal`; `completeOAuth` / `FlowInput` `principal`), failing with `principal-mismatch` on a different or missing principal (login CSRF). `service.test` answers "Reconnect required." only for `needs-auth` errors; other failures (outage, network, store) answer "Temporarily unavailable" and go to the new `onError` (default `console.warn`).

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Observability: `config.observe(event)` reports phase durations (`lock.wait`, `turn.prepare`, `compaction`, `state.write`, `message.write`, `model.call`, `tool.execute` spans) and counters (`hook.failed`, `hook.timeout`, `events.overflow`, `state.conflict`, `tool-source.backoff`, `warning`), zero cost when unset; new guide with an OpenTelemetry bridge. The default warning handler dedupes per code + key within a time window (`warnings.dedupeWindowMs`, default 60 000) instead of forever and counts the suppressed repeats in the next report. Every numeric option is bounds-checked at boot (`recovery.staleMs`, `recovery.abortPollMs`, `streams.*`, `inbox.*`, `hooks.timeoutMs`, `toolSources.*`, `settings.timeout.*`, `sessionIdleMs`, `warnings.*`; durations above one day are rejected) with `EH_CONFIG_INVALID`. **BREAKING:** `debug.invariants` is explicit only and is no longer switched on by `NODE_ENV` `test` / `development` (enable it in your test setup with `debug: { invariants: true }`); option values that were silently accepted before (for example `streams.flushMs: 0`, a duration above one day) now throw at boot.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - One error taxonomy (spec 10 §1.2). Every code lives in a single list (`src/codes.ts`; `HarnessErrorCode`, `HarnessNoticeCode` and `WarningCode` are derived from it and a test keeps it in sync with spec 10). New codes: `EH_LOCK_UNAVAILABLE`, `EH_EVENTS_OVERFLOW`, `EH_PROVIDER_AUTH`, `EH_PROVIDER`, `EH_RUN_FAILED`.
  
  - **BREAKING:** `TurnResult.error` is `{ code: HarnessErrorCode | HarnessNoticeCode; message; details? }` and `code` is always set (a failed turn without a more specific code is `EH_RUN_FAILED`); `NoticePayload.code`, the stored `metadata.eharness.error.code`, and the activity `turn-ended` error use the same union instead of `string` (`InboxRetryOptions.nonRetryable` keeps `code?: string`: an inbox failure may carry any error's code). Migration: comparisons with a free string still work at runtime, but a code that is not in the union is now a compile error.
  - **BREAKING:** public paths throw `HarnessError`, never a plain `Error` / `TypeError`: `inMemoryFs` seeds (`EH_CONFIG_INVALID`) and wrong `write` / `writeBytes` arguments (`EH_INVALID_INPUT`), `mountFs` / path-prefix options, `agent.session('')` / `agent.peek('')` (`EH_INVALID_INPUT`), `MessageAdapter.load` with both `fromId` and `beforeId`, `subagent({ approvals: 'inline' })` without `answer`, `wrapPlugin` overrides, and the skill-source contract checks. Migration: catch with `isHarnessError(error, code)` instead of `instanceof TypeError`. `bun run lint` now fails on an unmarked `throw new Error(…)` in non-test `src/` (`scripts/check-throws.ts`).
  - **BREAKING (custom `SessionLock`s):** a lock rejects with `HarnessError('EH_SESSION_BUSY')` when the session is held elsewhere (contention). Any other rejection is a failing lock service and now ends the turn with `EH_LOCK_UNAVAILABLE` (HTTP 503, logged) instead of a misleading `EH_SESSION_BUSY`; `session.recover()` returns `reason: 'lock-unavailable'` (new) next to `'locked'`. `lockConformance` checks the code.
  - **BREAKING:** `session.events()`: a reader that falls more than 1 000 events behind is errored with `EH_EVENTS_OVERFLOW` and logged once, instead of ending like a normal close (lost events went unnoticed). Events are copied once per emit, shared read-only by the readers.
  - A failing `isActive` probe while following a remote turn ends the stream with `EH_STORAGE` after 5 consecutive failures instead of polling forever; empty `catch {}` blocks that hid state-storage failures in the session now log (rate-limited).
  - Provider authentication failures are readable: an AI Gateway authentication error, a missing provider key (`LoadAPIKeyError`) and a provider 401/403 are `EH_PROVIDER_AUTH`, with a text that names `AI_GATEWAY_API_KEY` for the gateway; other provider failures are `EH_PROVIDER`. The quick start prints `result.error?.message` when the turn ends with `stop: 'error'`. Redaction rules are unchanged.
  - `EH_DUPLICATE_SKILL` names the `skills[i]` indexes when both declarations are in the same config. `SummarizeError.code` (`EH_COMPACTION_FAILED`) and `ClassifierUnavailableError.code` (`EH_PROVIDER`) added.
  - Client: `ChatSessionState.stopping`: `stop()` retries the interrupt twice, reports a failure through `notify` and keeps `stopping` / `busy` until the server confirms (it no longer leaves a ghost run behind a stopped UI). The activity feed counts a stream that ended without data (or with an `event: error` frame) as a failure (growing backoff), and `401` / `403` end it with the new terminal status `unauthorized`. The activity SSE stream sends `event: error` (no store details) before closing when its store fails.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - One glob compiler and one path normalisation. The five glob and gitignore compilers (`glob` tool, permission rules, `diskFs` ignore files, OpenAPI path filters, provider model filters) now share one core compiler (`compileGlobRegExp`, `compileGitignorePattern` with the options `dot`, `gitignore`, `caseFold`; also `collapseSegments`, `normalizeRootedPath`, `foldSegment`, `escapeRegExp`, `statelessPattern`, `unsafePatternReason` exported from the core), and the filesystem, memory and permissions path helpers share `collapseSegments`. Matching is unchanged for every pattern we compared before and after, except: consecutive `**` collapse, a pattern with more than 4 `**` segments or 8 `*` wildcards is refused (`glob` tool: `ERROR: invalid pattern`; a permission rule or ignore line that cannot compile never matches; an OpenAPI path filter throws `EH_CONFIG_INVALID`; a provider model pattern falls back to equality). This fixes a ReDoS: `**/` repeated ten times took 427 ms per path and the `glob` tool is auto-approved. Fixed: `a//b` in a gitignore line no longer matches a literal double slash (empty segments are skipped like in `diskFs` ignore files), and trailing spaces of a case-insensitive permission pattern are dropped like in the case-sensitive one. Fixed: `hiddenPrefixes` and `readonlyPrefixes` of the filesystem tools are compared case-insensitively on NFC-folded segments, like the permissions engine, so `/Secrets` is hidden when `/secrets` is.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - One judge call when permissions auto mode and `guard()` are both active (ADR-0060 amendment, spec 15 §7, spec 18 §12): with the same judge model and view limits, the auto classifier answers the guard's policy in its own call (`{ auto, guard }` verdict) and the guard records its half without a second model call; outcomes are unchanged (most restrictive wins). New core `judgeCoordinator(scope)` and the `JudgeParticipant`/`JudgeCoordinator` types (Draft), `Judge.combinable`/`cachedVerdict`/`limits`, `JudgeContext.alongside`/`precomputed`, `AutoClassifierContext.coordinator`/`toolCallId`/`risk`, and `guard({ combineWithAutoMode })` (default `true`; `false` keeps two calls).

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** one naming convention across the public API. Plugin factories are named like the
  plugin's runtime `name` (runtime names, and so persisted plugin state, do not change); in-memory
  implementations use the `inMemory` prefix; tool and skill sources end in `Source`; every plugin,
  source, adapter and store factory takes one `options` object; `run.toResponse()` is the safe HTTP
  answer; `session.edit()` takes one object; `session.abort()` is awaitable and cross-process. There
  are no deprecated aliases: rename at the call sites.
  
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
  
  Migration: apply the table with a search and replace per symbol (word-boundary aware), then move the
  leading positional argument of the listed factories into the options object. `session.abort()`
  callers that ignored the return value can keep doing so; they now also get a promise that rejects
  with `EH_STORAGE` / `EH_SESSION_CLOSED` where `requestAbort()` did. Subpaths such as
  `eharness/storage/memory` and `eharness/filesystem/memory` keep their paths.

- [`920c983`](https://github.com/viandwi24/eharness/commit/920c983d14f1aaa8cb23e9b8a241361becec0b07) Thanks [@viandwi24](https://github.com/viandwi24)! - `openRouterCatalog(data)` converts the OpenRouter model list (`GET /api/v1/models`) into a `models` catalog (context windows, max output, prices per 1M tokens), next to `modelsDevCatalog`. Pure: the application fetches and caches the list. See spec 12 §1.

- [`84f8bc9`](https://github.com/viandwi24/eharness/commit/84f8bc9d7b89714ca1ce8ad8f3418e990e4d0534) Thanks [@viandwi24](https://github.com/viandwi24)! - `subagent({ approvals: 'park' })` now offers `send_message`, the `name` field of `agent`, `agent_output` and `agent_stop`. The agent directory is rebuilt from storage (`selfAgent`), messages travel over the durable inbox (`child.enqueue`, steer for a running child, a new turn for a finished one, `main` through `parentAgent`), and the report of a resumed child is enqueued into its launcher through storage. See ADR-0041 and spec 20 §5.9.

- [`b5ba722`](https://github.com/viandwi24/eharness/commit/b5ba72244f803ab90120d6d0ff0bb18a8f341052) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** Partial resolution of pending approvals. `respond()` with only some of the pending approvals or client tool outputs now records them in the stored pending state (`PendingState.approvals[].answer`, `clientTools[].answer`, compare-and-set, any instance, idempotent per id, a differing re-answer is `EH_INVALID_INPUT` with `details.reason: 'conflict'`) and ends at once with `stop: 'tool-pending'` and `TurnResult.partial: true`. The call that answers the last missing item continues the same message with all answers, as a full `respond()` would; `endTurn` and the other options belong to that completing call. A call that answers nothing is still `'incomplete'`. See spec 11 §4.3 and ADR-0044.
  
  Migration: before, `respond()` with only some of the pending ids rejected with `EH_INVALID_INPUT` (`details.reason: 'incomplete'`). It now succeeds with `stop: 'tool-pending'` and `partial: true`. Code that relied on the rejection (to force a client to answer everything) must check `TurnResult.partial` or compare the answered ids with the pending ones itself.

- [`3090e93`](https://github.com/viandwi24/eharness/commit/3090e9304c8dcadff8083e206fe0da6d62382c7f) Thanks [@viandwi24](https://github.com/viandwi24)! - Peer dependency floors rise to the versions the library is built and tested against: `ai@^7.0.137` (was `^7.0.127`) and optional `@ai-sdk/mcp@^2.0.73` (was `^2.0.66`). Migration: update `ai` (and `@ai-sdk/mcp` if you use `eharness/mcp`) to at least these versions; `eharness/mcp` is type-checked against `@ai-sdk/mcp` 2.0.7x.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Numeric options of `todos()`, `ask()`, `group()`, `webFetch()` and `shell()` are validated: BREAKING, invalid values (negative, zero where a positive number is required, fractions for counts, `ask` `maxQuestions` above 4) now throw `EH_CONFIG_INVALID` instead of being clamped silently. `listRemoteMcpTools` now times out like `mcpServerSource` (`timeoutMs`, default 15 s). Config errors of `approvalGuard()` now read `guard: …` instead of `approvalGuard: …`. JSDoc examples and version notes corrected.

- [`33df08a`](https://github.com/viandwi24/eharness/commit/33df08a49c61685c7ed65052bad1e017957d343d) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/providers` (spec 23, ADR-0048, ADR-0053; Draft): provider definitions with zod settings (OpenRouter, AI Gateway, OpenAI, Anthropic, OpenAI-compatible; the app passes the provider factory), profiles and a `ProfileStore` port with `inMemoryProfileStore()`, `createProviderManager()` (`resolve('profile:model')`, merged model lists, `catalog()` for the agent's `models` option, connection tests, redacted `describe()`), a framework-neutral form spec (`formSpec`, with `FieldMeta.optionLabels` for display labels of enum values), secret redaction and edit-without-resending (`redactSettings`, `mergeSecretPatch`), `fromEnv`, and a cached models.dev / OpenRouter loader with an injected `fetch` and a `CatalogCache` port.
  
  - `ProviderManager.models(id, { includeDisabled: true })` also lists the models a profile's `allow` / `deny` hides, each marked `enabled`, so a UI can offer per-model switches. Overlapping profile reloads keep the newest snapshot.
  - The generic `SecretVault` (`webCryptoVault` with key rotation, `plaintextVault`, `withLegacyVault(vault, legacy)` to read an older sealing format and write the current one) and `sealedProfileStore({ onUnreadable })` (skips rows that cannot be opened, also in `reseal()`).
  - `gatewayProvider` maps only `AI_GATEWAY_API_KEY`: `@ai-sdk/gateway` has no base-URL environment variable.
  
  `eharness/testing` adds `profileStoreConformance` and `scriptedProvider`.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Resource bounds. `diskFs` ripgrep searches are killed after `grepTimeoutMs` (default 30 000) or `grepMaxOutputBytes` (default 64 MiB), pass `--max-count`, and fall back to the JavaScript path reporting the reason through `onGrepFallback`. The local shell sandbox's `wait()` no longer hangs when a process that escaped the process group keeps stdout open: it resolves from the exit event after the 2 s grace period and ends the pipes. **BREAKING:** background subagent children (`'park'` mode) are bounded by default: `background.timeoutMs` defaults to one hour (`Number.POSITIVE_INFINITY` opts out) and `stopOnTimeout` defaults to `true`, enforced by a timer (`reconcileEveryMs` defaults to `min(60 000, timeoutMs / 4)`). Migration: pass `background: { timeoutMs: Number.POSITIVE_INFINITY, stopOnTimeout: false }` for the old behaviour. The memory adapters no longer grow without bound: the budget ledger deletes settled reservations and sweeps long-expired ones (`expiredRetentionMs`), the stream log sweep runs at most once per second, and the inbox keeps at most `maxDeadLetters` (default 1000) dead letters.

- [`bddd0c3`](https://github.com/viandwi24/eharness/commit/bddd0c3d489be362e24b7dcfd011bee38c7d91ac) Thanks [@viandwi24](https://github.com/viandwi24)! - Restart recovery and background-child reliability (ADR-0056). `recovery.instanceId` (stable owner id: a restarted process recovers its own orphaned turns at once instead of after `staleMs`), `session.recover()` (repair an interrupted turn at boot; open text parts are closed too), `inject({ key })` (idempotent kind messages) and `reconcileBackgroundChildren` from `eharness/subagent` (delivers missing reports of ended / crashed / never-started / timed-out children and one reminder for children waiting for a person; new `background.timeoutMs`, `stopOnTimeout`, `startGraceMs`, `waitingReminderMs`, `reconcileEveryMs`). Report events carry `data.turnId` and new `data.status` values `interrupted`, `timed_out`, `not_started`; the hook retries delivery.

- [`aad96fd`](https://github.com/viandwi24/eharness/commit/aad96fd952185698c616053858e9aa6e164c9dad) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING (stream shape and cursor):** Resume of a `respond()` continuation now works with AI SDK `resumeStream()`: `attach()`, `attachRemote()`, the stream log and `handleResumeRequest()` start with a replay of the continued message (`start` + rebuilt parts), then the continuation chunks. `from` counts chunks of that replay. New export `messageToChunks()`. See ADR-0045 and spec 04 §6.3.
  
  Migration: a client that resumes a `respond()` continuation now receives the replay chunks first, and stored `from` cursors count them; drop cursors saved before the upgrade (resume from `0`). Readers that already rebuild messages from the stream (`useChat`, `readUIMessageStream`) need no change.

- [`5ed4f62`](https://github.com/viandwi24/eharness/commit/5ed4f62d2d4731edcf90d483374ac0a62353404e) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING (test/dev):** Session invariants are enforced and fuzz-tested (spec 05 §15, ADR-0057). Every message the core saves is validated against AI SDK `UIMessage`: with `debug: { invariants: true }` (explicit only; off by default) an invalid message is `EH_INVALID_MESSAGE` and nothing is saved; otherwise it is warned (`W_INVALID_MESSAGE`, `details.stage: 'save'`) and saved as it is. On load, a message that holds pending state or the active turn is kept with a warning instead of dropped. New warning `W_INVARIANT_VIOLATION`.
  
  Fixes found by the new fuzz test: a hot loop when a direct send was gated behind a queue held by pending approvals; inbox claims of a restarted process with a stable `recovery.instanceId` were renewed forever (claims now use `<instanceId>#<incarnation>`); a queued or waiting `send()` held by approvals another instance answered never started; an idle handle with unwritten local state stayed blind to another instance's pending state; a `respond()` rejected as stale after another instance patched an older message; an inbox drain whose turn kept failing before its commit point (lock held elsewhere) claimed and released in a loop (now exponential backoff).
  
  `eharness/testing` adds `multiInstanceConformance` (whole storage backend shared by several agent instances) and `assertStoredSessionInvariants`.
  
  Migration: with `debug: { invariants: true }` (put it in your test setup), a message that is not a valid AI SDK `UIMessage` throws `EH_INVALID_MESSAGE` and nothing is saved (fix the producer); without it the message is saved with a `W_INVALID_MESSAGE` warning. `WarningCode` gains `W_INVARIANT_VIOLATION`: exhaustive `switch`es need a case.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - One shared LLM judge engine (ADR-0060, spec 15, spec 18 §12): new core `createJudge({ model, role, instructions, policy?, environment?, … })` (plus `JudgeUnavailableError` and the `Judge*` types; Draft) owns the structured-verdict model call, the restricted-transcript renderer, fail-closed truncation, the verdict cache (TTL and bound), the circuit breaker, retries, timeout and `observeModel`. `guard()` is now role `tighten` (never approves) and `modelClassifier()` role `decide` (may approve), both thin wrappers; behaviour is kept, with these changes: the judge call caps output at 1024 tokens and uses temperature 0 (the guard too), the prompt is framed as `<policy>` / `<environment>` / `<transcript>` / `<action>` blocks with a JSON transcript for both, `modelClassifier()` gains an opt-in `cache`. No public type of `eharness/guard` or `eharness/permissions` changes (the docs listed `canonicalJson`/`verdictKey` as guard exports; they were never in its index and are internal to the engine now). New guide "LLM judge: two modes".

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `localSandbox` no longer passes the whole `process.env` to commands. A command inherits only an allow-list (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, plus the usual Windows variables; exported as `SAFE_ENV_NAMES`), so provider keys and database URLs of the host process do not reach commands the model writes. Migration: add what a project needs through `localSandbox({ root, env })`, or pass `inheritEnv: true` for the old behaviour. The `examples/coder` CLI now adds git, package-manager and proxy variables explicitly. `bash_output` `filter` and `notify_on` now accept only the safe regex subset of the `grep` tool (no quantified groups, one variable quantifier) and test only the first 2 000 characters of a line, so a pattern from the model cannot freeze the process (ReDoS); an unsafe pattern is returned to the model as an error string.

- [`84f8bc9`](https://github.com/viandwi24/eharness/commit/84f8bc9d7b89714ca1ce8ad8f3418e990e4d0534) Thanks [@viandwi24](https://github.com/viandwi24)! - Resumable streams across instances: a `StreamLogAdapter` port (`storage.streams`, `streams` options), `inMemoryStreamLog()` (`eharness/storage/memory`), `streamLogConformance` (`eharness/testing`), `session.attachRemote({ from, signal })`, `handleResumeRequest()` for AI SDK `useChat({ resume: true })`, and the `W_STREAM_LOG_FAILED` warning. See ADR-0039 and spec 04 §6.2.

- [`23ec4fe`](https://github.com/viandwi24/eharness/commit/23ec4fe883759f815993c29261032ad716ffae49) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING (default):** Progress guard sees returned failures. A tool result that is a text (or JSON string) starting with `ERROR:` now counts as a failed result for the error streak and for progress, and the new `loop.progress.toolErrorStreak` (default 8) stops a turn that keeps failing with one tool whatever its inputs, even when other tools succeed in between (`W_LOOP_STUCK` `details.kind: 'tool-errors'`). See spec 05 §3.2.
  
  Migration: turns that previously ran on (several failing calls of one tool, or `ERROR:` results) can now stop with `W_LOOP_STUCK`. Raise `loop.progress.toolErrorStreak` (a positive integer; a very large value effectively restores the old behaviour).

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** the public surface is trimmed to plugin factories and option types, ports and adapters, tool-name constants, stored-text constants and documented helpers. Implementation helpers and instruction/nudge/preamble texts are no longer exported (they stay internal and may change in any release; override options such as `instructions`, `reminder` and `preamble` still work). `eharness/client` no longer re-exports `http` and `activity` types except documented aliases, `withLegacyVault` and `LegacyOpener` moved from `eharness/providers` to `examples/team`, and `BUILTIN_TOOLS` in connectors is no longer exported (a test keeps its names in sync with the plugin constants). Migration: if you imported a removed name, copy the few lines you need or open an issue to have it documented. Removed per entry point:
  
  - `eharness`: `FINAL_ANSWER_DESCRIPTION`, `MAX_STEPS_WRAP_UP`, `OUTPUT_INSTRUCTION`, `OUTPUT_RETRY`, `PAGE_CONTEXT_PREAMBLE`, `PROGRESS_NUDGE`. Texts that appear in stored messages or tool results (`INTERRUPTED_*`, `DENIED_NEW_INPUT`, `WAIT_TIMED_OUT`, `TOOL_OUTPUT_TRUNCATED`, ...) stay exported.
  - `eharness/activity`: `encodeActivityEvent`, `pruneBoundary`. `eharness/ask`: `ASK_DESCRIPTION`, `formatAnswers`, `parseQuestions`. `eharness/client`: `createSseParser`, `createStore`, `parseActivityEvent`.
  - `eharness/connectors`: `BUILTIN_TOOLS`, `DEFAULT_FLOW_TTL_MS`, `assertSecureUrl`, `buildAuthorizationUrl`, `connectorForm`, `defaultConnectionLabel`, the OAuth discovery/exchange helpers (`discoverAuthorizationServer`, `discoverProtectedResource`, `exchangeCode`, `generatePkce`, `generateState`, `pkceChallenge`, `pollDeviceToken`, `refreshTokens`, `registerClient`, `requestDeviceCode`, `resourceMetadataFromChallenge`), `flowStepsOf`, `resolveFlowDeps`, and the vaults `plaintextVault` / `webCryptoVault` (use `eharness/providers`).
  - `eharness/filesystem`: `bytesToBase64`, `checkpointTurnKey`, `copyCheckpoints`, `defaultNestedInstructionsFrame`, `defaultProjectInstructionsFrame`, `imageDimensions`.
  - `eharness/group`: `GROUP_HISTORY_PREAMBLE`, `GROUP_SPEAKER_PREFIX`. `eharness/guard`: `GUARD_DEFAULT_POLICY`, `GUARD_INSTRUCTIONS`, `GUARD_PROMPT`, `GUARD_TRUNCATED`, `canonicalJson`, `verdictKey`.
  - `eharness/http`: `classifyChatBody`, `httpError`, `sanitizeChatBody`, `statusOfCode`. `eharness/mcp`: `MCP_AUTO_DEFER_THRESHOLD`, `remoteMcpTransport`. `eharness/openapi`: `OPENAPI_AUTO_DEFER_THRESHOLD`, `riskFromMethod`.
  - `eharness/memory`: `DEFAULT_MAX_FILE_CHARS`, `DEFAULT_MAX_PINNED_CHARS`, `MEMORY_FLUSH_PROMPT`, `MEMORY_PROTOCOL`, `PINNED_PREAMBLE`.
  - `eharness/permissions`: `AUTO_CLASSIFIER_INSTRUCTIONS`, `AUTO_MAX_CONSECUTIVE_BLOCKS`, `AUTO_MAX_TOTAL_BLOCKS`, `DEFAULT_ALIASES`, `DEFAULT_BUILTIN_ASK`, `DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS`, `READ_ONLY_COMMAND_NAMES`, `isGlobArg`, `isReadOnlySubcommand`, `matchBashSpec`, `parseCommand`, `readPathArguments`, `restrictiveForms`.
  - `eharness/providers`: catalog constants and parsers (`DEFAULT_CATALOG_TIMEOUT_MS`, `DEFAULT_CATALOG_TTL_MS`, `GATEWAY_MODELS_DEV_PROVIDERS`, `MODELS_DEV_URL`, `OPENROUTER_MODELS_URL`, `loadCachedJson`, `parseModelsDevModels`, `parseOpenRouterModels`), `SEALED_KEY`, `endpointChanged`, `mergeSecretPatch`, `providerFormSpec`, `scrub`, `secretValuesOf`, `withLegacyVault`.
  - `eharness/shell`: `MAX_TASK_OUTPUT`, `SANDBOX_HINT`, `seatbeltProfile`, `wrapCommand`. `eharness/subagent`: `AGENT_MESSAGE_INSTRUCTIONS`, `AGENT_MESSAGE_MAX_CHARS`, `AGENT_NAME_PATTERN`, `AGENT_OUTPUT_PAGE_CHARS`, `AGENT_REPORT_MAX_CHARS`, `subagentWaitId`. `eharness/todos`: `TODOS_CONTINUE`, `TODOS_INSTRUCTION`, `TODOS_REMINDER`. `eharness/web`: `htmlToText`, `matchHost`.
  
  The default model id lives in one constant in `eharness/providers`. The export list of the package is now a committed snapshot derived from `package.json#exports` (`scripts/exports.snapshot.json`, checked by `bun test` and by the Node smoke test), so every public export change is a reviewed diff. Draft subpaths carry a "all symbols are experimental" header and Draft core symbols (`observeModel`, `handleResumeRequest`, `attachRemote`, `StreamLogAdapter`, the model catalog and cost functions) are marked `@experimental`.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `eharness/web` no longer re-exports `isPrivateHost`; import it from `eharness` (the core export `web_fetch` now uses too, one implementation for IPv4-mapped, NAT64, 6to4 and Teredo ranges). Migration: `import { isPrivateHost } from 'eharness'`.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Add the experimental `withToolExecute(tool, execute)` and `withToolFields(tool, fields)` helpers: copy a tool with a new `execute` or changed `deferLoading` / `toModelOutput` / `metadata`, keeping every other field, with the `Tool` cast in one place. Internal wrappers (filesystem, MCP, OpenAPI, registry) use them.

### Patch Changes

- [`02c64cf`](https://github.com/viandwi24/eharness/commit/02c64cf3826e09533f09b0da0de4e82083fd8794) Thanks [@viandwi24](https://github.com/viandwi24)! - Fix a stored message being dropped (`W_INVALID_MESSAGE`) after a person approved a call that the re-validation of the `respond()` continuation then denied: `output-denied` tool parts now always have `approval.approved: false` (persistence, projection), and cold load repairs the known inconsistency with `W_REPAIRED_MESSAGE` instead of dropping the message. In `auto` mode a call a person approved is never classified again (`noteApproval(toolCallId)`, called by the permissions plugin), so the classifier cannot overrule an approval.
  
  `modelClassifier` now sends `maxOutputTokens` (default `DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS` = 1024) and `temperature` 0 (both configurable), and throws `ClassifierUnavailableError` when the judge could not run: the action is still denied (`auto: 'unavailable'`, `unavailable` auto event) but no longer counts as a block towards the repeated-blocks pause. See ADR-0055, spec 03 §6-7, spec 18 §12.
  
  New in `eharness/testing`: `schemaCheckedMessages(adapter)` / `assertValidUIMessage(message)` fail a save of a schema-invalid `UIMessage`.
  
  Behaviour change (no migration): `modelClassifier` now sends `maxOutputTokens` and `temperature` to the judge model, and a judge outage is `auto: 'unavailable'` (denied, not counted as a block). Stored `output-denied` parts always have `approved: false`.

- [`2dc5b4c`](https://github.com/viandwi24/eharness/commit/2dc5b4c1ec4a361ffdcf9115926d6b345cbed43a) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/client`: `createChatSession` refetches the stored messages when a turn this chat streamed itself ends, if the server announced stored messages meanwhile (`storedElsewhere()` was called while busy). Kind messages stored during the turn (events, notices) now show without waiting for the next event, and the optimistic user message (an id AI SDK made up) is replaced by the stored one.

- [`2dc5b4c`](https://github.com/viandwi24/eharness/commit/2dc5b4c1ec4a361ffdcf9115926d6b345cbed43a) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/client`: a `ChatSession` refetch no longer leaves a hole in the history when more than one page of messages was stored while the tab was away (the stale older messages are dropped and "load older" fills the gap), and an optimistic user message never survives a refetch that holds the message the server stored.

- [`a38c7f0`](https://github.com/viandwi24/eharness/commit/a38c7f0df321ca670b50f14a08f4aaaf8f42ff0a) Thanks [@viandwi24](https://github.com/viandwi24)! - The default compaction prompt tells the summarizer that the most recent messages are kept after its summary, so a brief of only the early turns no longer claims that nothing was asked or decided yet.

- [`8eb391e`](https://github.com/viandwi24/eharness/commit/8eb391ede69248938eeb99cb47cd9c63f786121c) Thanks [@viandwi24](https://github.com/viandwi24)! - Core robustness fixes. A throwing `onWarning` handler or `logger` no longer hangs the session (the end of a turn always releases the lock, resolves `run.result` and closes the stream); concurrent `inject({ key })` calls with the same key store one message; the wait-timeout expiry timer backs off (250 ms to 30 s) while state storage fails instead of retrying every millisecond; a failed `regenerate()` / `edit()` no longer leaves a ghost rewind that hides history; the stream log is kept alive during quiet turns (optional `expire` as keep-alive) and restarted from 0 after a gap, and `inMemoryStreamLog` no longer creates an empty log on a gap (adapters must reject `at` > 0 on a missing log without creating it); `ifBusy: 'wait'` no longer leaks abort listeners; a tool output that `structuredClone` cannot copy is converted to a JSON-safe copy (or an error string) instead of killing the turn; the heartbeat timer cannot stack ticks; `activityStream` honours backpressure (512-frame queue) and a `session.events()` reader that falls 1 000 events behind is closed instead of buffering without bound.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - `approval.secret` and the `tool.before` hook are marked `@experimental`: they rely on the AI SDK options `experimental_toolApprovalSecret` and `experimental_refineToolInput`. A contract test and a CI job against `ai@latest` and the lowest supported `zod` now catch an upstream rename.

- [`02c64cf`](https://github.com/viandwi24/eharness/commit/02c64cf3826e09533f09b0da0de4e82083fd8794) Thanks [@viandwi24](https://github.com/viandwi24)! - A `wake` injection (`inject(…, { wake: true })`, background subagent reports) that arrives while approvals, client tool calls or external waits are pending is now held in the durable inbox when `storage.inbox` exists: it survives a restart and runs once in whichever instance resolves the pending items, instead of living only in the in-memory queue of the instance that received it (lost wake). `inject()` also reads the stored state, not the instance's cache, to decide whether the session can wake now. See spec 11 §6.3 and ADR-0054.
  
  Several undelivered `wake` injections now run as one wake turn (also in the in-memory queue), not one no-input turn per report.
  
  Behaviour change (no migration): a held wake now runs once in whichever instance resolves the pending items, and several wakes merge into one turn.

- [`7b945f5`](https://github.com/viandwi24/eharness/commit/7b945f5edc7df7adae96dbd22ed7cfac0baca474) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/mcp`: type-check against `@ai-sdk/mcp` 2.0.7x, whose `createMCPClient()` returns `MCPClient | ManagedMCPClient` and whose tool types use their own schema generics (the plugin only needs `tools()` and `close()`).

- [`ce4e933`](https://github.com/viandwi24/eharness/commit/ce4e93397ecf42120c26b3dd8e32c5b9dc34c68c) Thanks [@viandwi24](https://github.com/viandwi24)! - A foreground `approvals: 'park'` subagent whose parent call was cancelled by a new user message (or answered `Interrupted:`) now reports to the lead when it finishes, like a durable background child (`eh.event` `subagent`, woken), instead of finishing silently. See spec 20 §3.5, ADR-0046.

- [`54bac7d`](https://github.com/viandwi24/eharness/commit/54bac7d2ce600c18ece8f9e7b8ec46afe21aceca) Thanks [@viandwi24](https://github.com/viandwi24)! - Fix "This part type is not accepted from clients." when retrying an interrupted reply: a `regenerate-message` request is decided by `messageId` alone. `eharness/client` no longer sends the message before the reply (it can be a stored kind message such as a subagent event, with a `data-eh.event` part) nor an idempotency key taken from it, and `eharness/http` no longer validates the messages of a regenerate body.

- [`2dc5b4c`](https://github.com/viandwi24/eharness/commit/2dc5b4c1ec4a361ffdcf9115926d6b345cbed43a) Thanks [@viandwi24](https://github.com/viandwi24)! - Fix two regressions found in manual testing of the team example:
  
  - `eharness/subagent`: the background time limit (`background.timeoutMs`, enforced with `stopOnTimeout`) is measured from the start of the turn the child is running now, not from the child's creation. A background child resumed by a message hours after it was launched was reported as timed out and stopped seconds after it started ("Resumed subagent … failed. [subagent stopped: aborted]").
  - `eharness/client`: following a turn that continues an assistant message which is no longer the newest one (a `respond()` continuation after subagent events or other kind messages were stored behind the waiting reply, or a recovered turn) moved that message to the end before `resumeStream()`. AI SDK only replaces the last message, so the continuation was pushed as a second copy with the same id, which crashed keyed UI lists (Svelte `each_key_duplicate`, a blank "500 Internal Error" page after answering a question). The refetch after the turn restores the stored order.

- [`8eb391e`](https://github.com/viandwi24/eharness/commit/8eb391ede69248938eeb99cb47cd9c63f786121c) Thanks [@viandwi24](https://github.com/viandwi24)! - Security hardening from the 0.8 review. Behaviour changes to expect:
  
  - **Providers and connectors: secrets are bound to their endpoint.** A form field whose JSON Schema `format` is `uri`/`url` (`z.url()`), or that has `ehMeta({ endpoint: true })` (`FormField.endpoint`), is an endpoint. When a `mergeSecretPatch` / `putProfile` / `connectors.update` patch changes it (for example `baseURL`), the stored secrets and `secretValues` entries are no longer kept: they must be resent in the same patch, otherwise they are cleared (a required key fails validation with `EH_CONFIG_INVALID`). Connections also lose their OAuth credentials and go to `needs-auth`. New export `endpointChanged`. Forms that edited only the URL now need to ask for the key again.
  - **Permissions: case-insensitive restrictions.** Protected paths, the built-in `Read(.env*)` ask and user `deny`/`ask` rules match case-insensitively on NFC text, ignoring trailing dots and spaces of a segment, on every platform (`.GIT/config`, `.ENV`, `cp x .Git/config` now ask). `allow` rules stay exact.
  - **Permissions: dot-globs ask.** A read-only command whose glob can expand to `..` (`cat .[.]/.[.]/x`, `ls .?/`, `ls -d .*`, `grep -r x .[.]`) is no longer auto-approved; ordinary globs (`*.ts`, `.git*`) are unchanged.
  - **web_fetch private-host check:** trailing dots (`localhost.`, `x.local.`), NAT64, 6to4, Teredo, site-local, `100.64.0.0/10`, `198.18.0.0/15`, `0.0.0.0/8`, `192.0.0.0/24` and documentation ranges are refused; `deny`/`allow` patterns ignore a trailing dot. Without `resolveHost` a public name that resolves to a private address is still not caught (documented, with a Node example).
  - **Permissions: deny/ask rules see through evasions.** For `deny` and `ask` rules only (never `allow`), the command is also matched after dropping a leading `!`, reducing `/bin/rm`/`./rm` to `rm`, skipping git global options (`-C`, `-c`, `--no-pager`, `--git-dir`, `--work-tree`) and looking through `sudo`, `doas`, `env`, `exec`, `nice`, `timeout`, `nohup`, `command`, `builtin`, `time`, `sh|bash|zsh -c '…'` and `eval '…'`. `deny: ['Bash(rm:*)']` now denies `sudo rm x`; an unparseable `sh -c` payload asks when deny/ask rules exist. New exports `restrictiveForms`, `RestrictiveForms`.
  - **Permissions: session grants of shell tools are scoped to the command prefix (BEHAVIOUR CHANGE).** `remember: 'session'` on a shell approval now stores the tool plus the prefix `suggestRule` offers (`git commit`), so approving `git commit -m a` no longer approves `curl …`. Wrappers, interpreters, compound/complex commands, redirects and protected paths are never remembered. New core hook `tool.grantScope` (the permissions plugin implements it) and `PermissionEngine.grantScope()`. Old per-tool grants (`grants.bash`) are ignored for shell tools (the call asks again); grants of other tools are unchanged.
  - **Connectors: a custom remote MCP server's `read` capability defaults to `ask` (BEHAVIOUR CHANGE).** `readOnlyHint` comes from the server and is untrusted; `capabilitiesFromTools` now gives `read` `defaultMode: 'ask'` like `write`/`destructive`. Switch the mode to `allow` per enablement for servers you trust. Curated connectors keep their defaults.
  - **Permissions: protected-name search in shell text** also catches trailing dots/spaces and NFC variants (`cp x .git./config`, `cp x ".git /config"`).
  
  Docs: security notes for deny-rule limits, per-tool session grants, remote MCP `readOnlyHint`, shell environment inheritance and sandbox limits.

- [`ef4c793`](https://github.com/viandwi24/eharness/commit/ef4c7935aa502c649c9872afe68061bc6d0f327f) Thanks [@viandwi24](https://github.com/viandwi24)! - Multi-instance correctness. `session.stats()` on a cached idle handle re-reads `pending`, `activeTurn` and `usage` from storage, so `pendingSubagentApprovals` and approval lists no longer show a request another instance already answered (spec 05 section 2.2). A direct `send()` on an idle session with a durable inbox no longer overtakes older queued inbox items: the drain applies them first (spec 05 section 12 rule 7).
  
  Behaviour change (no migration): a direct `send()` waits for older queued inbox items instead of overtaking them, and `stats()` on a cached handle does an extra storage read.

- [`08db4c3`](https://github.com/viandwi24/eharness/commit/08db4c3df995d1a9cde27fcd786c3f27272b0998) Thanks [@viandwi24](https://github.com/viandwi24)! - Internal refactor, no behaviour or API change. `eharness/subagent`: the 3 100-line `subagent()` closure is split into modules over an explicit `Env` (resolved options) and `Scope` (one session's state); every execution mode (foreground, user-moved-to-background, background, park) now runs through one `withChildLifecycle` that owns the abort wiring, the concurrency slot and the child session handle, so no mode can leak a listener, a slot or an open child. Subpath modules reuse the core `isRecord` / `errorText` helpers instead of private copies, `eharness/connectors` shares the base64url of `eharness/providers`, and a few misleading comments are fixed.

## 0.7.0

### Minor Changes

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/ask`: `askUser()` adds `ask_user_question` (1–4 multiple-choice questions). It is a client tool by default (answered with `respond({ toolOutputs })`); `interactive: false` with `whenNoHuman` (`'dismiss' | 'error' | fn`) makes it answer itself for autonomous servers. Helpers: `formatAnswers`, `answerOutput`, `pendingQuestions`, `parseQuestions`, `ASK_TOOL`. See spec 21.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - `session.compact(options?)` takes `CompactOptions = { keepLast?, instructions? }` for that call only: `keepLast` overrides `compaction.keepLast` (`0` summarizes everything, including the newest completed turn; invalid values reject with `EH_INVALID_INPUT`), and `instructions` adds a focus line (`The user asked the summary to focus on: …`) to the summarizer context after plugin lines. The `compaction.prompt` hook event gains a read-only `instructions` field.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `session.stats()` measures the whole next request; new tool ordering, deferral and listing.
  
  - **BREAKING:** an idle `session.stats()` now measures the whole next request (skills index, turn-refresh instructions, skill and source tools), so `instructions` and `tools` can be larger than before, and it lists tool sources like a turn does. Deferred tools count 0 toward the totals. `ContextStats` gains `instructionBlocks` (`{ owner, refresh, tokens }`) and `toolSources` (`{ source, tools, tokens }`), also in `data-eh.context`. Re-check thresholds that depend on `stats()`.
  - `session.tools()` lists the tools of the next request in request order: `{ name, description?, inputSchema, source, deferred, tokens }` with `source` `'app' | 'core' | 'plugin:<name>' | 'source:<id>'` (deferred tools included, with their size). Type `SessionToolInfo`.
  - `config.toolOrder` lists final tool names first, in that order; the rest keep the default order. Names that match no tool warn once per session with the new `W_TOOL_ORDER`. Keep it stable: a changed order busts the prompt cache.
  - `config.deferTools` hides the named app, plugin or source tools until the model finds them with `tool_search`. When any tool is deferred the core adds a turn reminder listing the deferred tools by name with a one-line description (the reminder format is Draft).
  - A stored `media-ref` tool output (a filesystem image or PDF) is estimated like the wire it stands for instead of its JSON, and the prune stage measures media by a fixed size, so `stats.pruned.chars` is not inflated by base64.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/filesystem/node` (Node-only): file systems over real directories.
  
  - `diskFs(root, { readonly?, ignore?: { gitignore?, hidden? }, maxFileBytes?, maxBinaryBytes?, grep? })` is a `FileSystem` with `stat`, `grep` (ripgrep when on `PATH`, JavaScript fallback), `glob` and `move`; symlink-escape containment, a gitignore subset for hiding paths, mode-preserving atomic writes, compare-and-set under a per-path mutex, and readable errors for oversized files.
  - `mountFs(() => [{ virtual, fs, readonly? }])` composes file systems by longest prefix (a cross-mount move is not atomic).
  - `nodeWorkspace({ root, extraDirs?, toolOutputsDir? })` builds the usual root + extra directories + tool-outputs workspace (`fs`, `mounts()`, `addDirectory`, `toReal`, `toVirtual`). `nodeCheckpointStore(dir)` is a JSON-file `CheckpointStore`. `DEFAULT_MAX_BINARY_BYTES` is exported.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `eharness/filesystem` changes the default tool list and error texts; it also gains binary files, multi-edit and checkpoints.
  
  - **BREAKING (tool list):** a `glob({ pattern, path? })` tool is on by default (`**`, `*`, `?`, `[abc]`, `{a,b}`; newest first when the adapter provides `updatedAt`; max 200), which changes the tool list and the prompt-cache prefix. Migration: pass `tools` without `'glob'` to keep the old list. Adapters may add a fast path `FileSystem.glob?`; the matcher is exported as `compileGlob`.
  - **BREAKING (model-visible):** exceptions thrown by an adapter (`read`, `write`, `list`, …) now reach the model as `ERROR: <message>` (and `classifyToolResult` says `'error'`) instead of an ordinary `Error: …` tool error. Migration: `onAdapterError(error, { tool, path })` customises the text; returning `undefined` rethrows (the old behaviour).
  - **BREAKING (input):** `edit_file` accepts `edits: [{ old_string, new_string, replace_all? }]` (1–50), applied in order, all or nothing (`ERROR: edit 3 of 5: …`), with one staleness check and one write. The single `old_string` / `new_string` form still works.
  - **BREAKING (binary files):** `list_files`, `stat` and `glob` show binary files; `read_file` shows PNG, JPEG, GIF and WebP images to the model (and PDFs with `media: { pdf: true }`; `filesystem({ media: { images?, pdf?, maxBytes? } })`); other binaries answer `ERROR: binary file …`, and `write_file` / `edit_file` refuse them. The stored output is a small `media-ref` (no base64 in messages or storage); `compaction.prune` prunes old images like any large output. `FileSystem` gains optional `readBytes` / `writeBytes` and `FileMeta.binary` / `mediaType` (`memoryFs` implements them; `fileSystemConformance` has `requireBytes` and `requireGlob`). New exports: `detectMediaType`, `imageDimensions`, `looksBinary`, `bytesToBase64`, `bytesVersion`, `isFileMediaRef`, `FileMediaRef`, `BinaryFile`. `fsSkillSource` returns binary skill assets when the file system has `readBytes`.
  - **Checkpoints:** `filesystem({ checkpoints })` takes a `CheckpointStore` and records a file's content before its first change of each turn. Exports: `memoryCheckpointStore`, `rewindFiles`, `checkpointsSince`, `checkpointTurnKey`, `checkpointedFs`, `copyCheckpoints`. The new `session.fork` hook copies the checkpoints of the kept turns into the forked session; `checkpointsSince` / `rewindFiles` accept `sessionIds` (typically `session.children()`).

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** `mcpServer` frames tool results as untrusted content by default.
  
  The text parts of every MCP tool result (including tools without `toModelOutput`, where a string output is framed as text) reach the model inside `<untrusted-content source="mcp" name="<server>/<tool>">…</untrusted-content>`. Images, structured JSON output and `isError` are unchanged, and the UI keeps the raw result. Migration: add `UNTRUSTED_CONTENT_INSTRUCTIONS` to your `instructions` so the model knows what the frame means; pass `mcpServer({ wrapUntrusted: false })` to keep the old output, and update golden prompts that contain MCP results.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** message projection escapes and neutralises framing in kind messages; new framing helper.
  
  - **BREAKING (model-visible):** the projections of `eh.event` and `eh.compaction` escape attribute values (the event `name`) and neutralise `event`, `system-reminder` and `untrusted-content` tags (plus `conversation-summary` in summaries) inside their text, so stored content cannot close or forge a frame. Text without such tags projects exactly as before; assertions on raw projected text with tags need an update.
  - New core helper `untrustedContent(text, { source, url?, name? })` (Draft) wraps outside text in `<untrusted-content source="…">…</untrusted-content>` with frame and `system-reminder` tags neutralised and attributes escaped; `UNTRUSTED_CONTENT_INSTRUCTIONS` is a recommended system-prompt sentence. New types: `UntrustedContentOptions`.
  - **BREAKING (stored shape):** tool parts in state `output-error` that carry the deprecated `rawInput` field (set by AI SDK's UI stream when a tool call's input fails to parse) are normalised to `input` before persisting, validating on load and projecting to the model, so AI SDK's `rawInput` deprecation warning is no longer logged.
  - The reasoning duration key `providerMetadata.eharness` is removed from reasoning parts on the provider wire.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/permissions`: rule-based tool permissions (Draft).
  
  - `createPermissionEngine({ roots, home?, mode?, rules?, protectedPaths?, readOnlyCommands?, toolKinds?, aliases?, modeCycle?, classifier?, persist? })` decides every call: `Tool(spec)` rules (`Bash(bun test *)`, `Read(.env*)`, `Edit(src/**)`, `WebFetch(domain:…)`, `Agent(name)`) with deny > ask > allow precedence, protected paths that ask in every mode, and a built-in `.env` ask.
  - Modes: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` and `auto`. `modeCycleFor({ bypass, auto })` builds the `cycleMode()` order.
  - **Auto mode (Draft):** the `classifier` option (`AutoClassifier`, e.g. `modelClassifier({ model, … })` with `AUTO_CLASSIFIER_INSTRUCTIONS`) decides the calls no rule or read-only check settles. A failing classifier blocks; repeated blocks (3 in a row, 20 in total) pause auto mode until a person approves (`autoState()`, `subscribeAuto()`, `noteApproval()`, `resumeAuto()`). `engine.decideAsync()` runs the classifier; `decide()` stays synchronous.
  - Shell commands are analysed without running them: a strict tokenizer (wrappers, redirects, `$(…)` and heredocs count as complex), argument grammars for read-only commands (allow-lists), lexical path containment, and `Read` / `Edit` rule matching on the paths a command touches. No new dependencies.
  - `permissionsPlugin({ engine, … })` wires the engine onto `tool.approve`, `step.prepare` (hides tools by mode and rule), `tool.after` (hides `Read`-protected paths from `grep`, `list_files`, `glob` output) and `approval.decided`, and registers `exit_plan_mode`. `toolKinds` maps tools (defaults cover eharness's own tools, including `send_message`, `agent_output` and `agent_stop` as `safe`); `ToolKindSpec.alwaysAsk` makes a tool ask in every mode, even `bypassPermissions`.
  - Works in the three deployment profiles: `dontAsk` plus an allow-list for autonomous servers, live `cycleMode()` for a CLI, a per-session `mode` function with `persist` (`{ op, kind, rule, scope }`; `'session'` scope rules are not stored) and `onPlanExit` for split web/server apps.
  
  Claude-Code-derived names (`bypassPermissions`, `acceptEdits`, `dontAsk`) are kept on purpose. See spec 18 and the permissions guide.

- [`84d6518`](https://github.com/viandwi24/eharness/commit/84d6518694a7d39fdf8188851b27050d8717aece) Thanks [@viandwi24](https://github.com/viandwi24)! - `eharness/filesystem` gains `projectInstructions()` and `loadProjectInstructions()` (Draft): the project's `CLAUDE.md` / `AGENTS.md` are loaded from the `fs` service (per directory the first of `files`, default `['CLAUDE.md', 'AGENTS.md']`, wins). The root file becomes a static instruction with a size cap (`maxChars`, default 40 000) and a frame (`frame`); nested files are listed to read on demand (`nested`, `maxNested`, `nestedFrame`). The result is provided as the `projectInstructions` service. The frames and defaults may change in a minor release.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** session APIs for interactive and multi-session harnesses; a few results change.
  
  - **BREAKING:** `send(input, { ifBusy: 'steer' })` returns the queued turn's run when the running turn refuses the steer at once (its step loop ended, or a manual `compact()` runs); before it returned an `attach()` of the running turn. `run.delivery` (`Promise<'step' | 'turn' | 'dropped'>`, type `SteerDelivery`) says what happened.
  - **BREAKING:** `PendingState.clientTools[]` entries gain `input` (plus `inputTruncated: true` and no `input` above 16 KB). The pending state stays `v: 2`; assertions that compare entries with `toEqual` now see `input`.
  - **BREAKING:** state writes of an owner with a `setIf` adapter are compare-and-sets that take over `core.children` on conflict (before, only writes during a turn were); the commit-point write no longer fails with `EH_SESSION_BUSY` when only a child registered meanwhile. Make sure your `StateAdapter.setIf` is a real compare-and-set.
  - **BREAKING (type-level):** `WarningCode` gains `W_TOOL_ORDER`; `SessionStateSnapshot.core` gains `parent`, `children`, `forkedFrom`.
  - `session.fork({ beforeMessageId?, id?, runtime?, copyState? })` creates a session from a prefix of the history and returns its opened handle (message ids kept; usage, grants, plugin state and compaction / rewind pointers copied; lineage in `core.forkedFrom`; `EH_SESSION_BUSY` while a turn runs). The new `session.fork` hook runs after the copy (a throwing hook is `W_HOOK_FAILED`; the fork succeeds).
  - `session.children()` and `session.parentInfo()` read a durable parent / child index (`SessionOptions.parent` registers the child; append-only, capped at 500). `ctx.session.parent` is also set when an existing child session is opened without options.
  - `session.onRun(listener)` is called synchronously whenever any turn of the session starts in this process (`send`, `respond`, `regenerate`, `edit`, queued turns, steer fallbacks, wakes from `inject`, inbox drains); every listener gets its own `HarnessRun`.
  - `ctx.session.inject(kind, data, options?)` lets a plugin inject a kind message into its own session from tools, hooks and background work, with the semantics of `session.inject()`.
  - `respond({ approvals: [{ id, approved, note }] })` takes a note (max 4 000 characters): an approved call's note is read by the model right after the tool result as `<user-note>` and stored as `approvalNote` of `data-eh.input`; a note on a denial is appended to its `reason`. `respond(…, { endTurn: 'after-answers' | 'if-denied' })` runs the approved tools without calling the model (the turn stops `'complete'` with `steps: 0`). `StepPrepareEvent.continuing` lists the tools a `respond()` answered on step 0.
  - `TurnInfo.addUsage()` accepts plain token counts (`PlainUsage`, `AddUsageInput`) besides AI SDK usage.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/shell` (Node-only): the `shell()` plugin and a local sandbox.
  
  - `shell({ sandbox, timeoutMs?, maxTimeoutMs?, maxOutputChars?, background?, onTaskEvent?, toolName?, risk? })` contributes the `bash` tool (`metadata.risk: 'external'` by default; capped output, timeouts, process-group kill, a description that states the sandbox state) and the transient `data-shell.output` part for live output. Tool names are exported as `BASH_TOOL`, `BASH_OUTPUT_TOOL` and `KILL_SHELL_TOOL`.
  - With `background` it also offers `run_in_background` and `notify_on` on `bash`, plus `bash_output` and `kill_shell` (names kept from Claude Code). Task exits and monitor matches are injected into the session as `eh.event` messages by the plugin itself (`wake` by default); `onTaskEvent` overrides delivery.
  - The `shellTasks` service (`list`, `get`, `output`, `stop`, `stopAll`, `subscribe`, `moveToBackground(toolCallId?)`) serves UIs. `moveToBackground()` detaches running foreground `bash` calls into `bash-<n>` tasks (Claude Code's Ctrl+B); the call returns at once and the task notifies on exit.
  - `localSandbox(root, { os?, env?, shell? })`: an AI SDK sandbox over child processes in their own process groups, with optional OS isolation (macOS Seatbelt, Linux bubblewrap) and `state()` / `setOs()` (`SandboxState` includes `writableRoots`). Also `detectOsSandbox()` and `killAllSandboxProcesses()`.
  
  See spec 19 and the shell guide.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** the stream of a `respond()` continuation starts with `tool-approval-response` chunks, and reasoning parts carry a duration.
  
  - **BREAKING (chunk order):** a `respond()` continuation writes one `tool-approval-response` chunk per consumed approval (the stored approval id, `approved`, `reason`) between `start` and the first tool output. Readers that rebuild the assistant message from the stream (`readUIMessageStream`, `attach()`, non-`useChat` UIs) now see answered calls leave `approval-requested` at once instead of when the output arrives; `useChat` clients are unaffected. Granted calls deferred behind client outputs or external waits, and approved calls of tools without `execute`, get no chunk. Update golden streams.
  - Every `reasoning-end` chunk carries `providerMetadata.eharness.durationMs`, so UIs and stored reasoning parts can show how long the model thought. The key is removed from the provider wire.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/subagent`: the `subagents()` plugin (the `agent` tool).
  
  - `subagents({ agents, approvals, answer?, policy?, maxDepth?, maxConcurrent?, background?, messageTool?, outputTool?, stopTool?, maxReportChars?, messageLimits?, parkTimeoutMs?, childSessionId?, toolName?, selfAgent?, parentAgent?, onParentRun? })` runs a subagent as a child session: progress as preliminary outputs (`SubagentProgress`, status `running` / `completed` / `failed` / `stopped`), child usage and cost added to the parent turn, a depth limit, a per-depth concurrency cap, abort propagation, and the persisted `data-subagent.run` part (`{ toolCallId, sessionId, agent, status, name?, taskId? }`).
  - **Approval strategies** for the child: `'inline'` (an `answer` callback in process), `'policy'` (`'deny'` or `'approve'`, no human) and `'park'` (the parent parks as an external wait; the app answers the child session from any instance and the child's `turn.end` hook resolves the wait). Helpers: `subagentChild({ parent })`, `pendingSubagentApprovals()`, `subagentWaitId()` and `reconcileSubagentWaits()` (also run by `selfAgent`).
  - **Background agents:** `background: true | { default?, inChildren? }` offers `run_in_background` (`inline` and `policy` only). `default: true` runs an `agent` call in the background unless the model passes `run_in_background: false`; `inChildren` offers the field in child sessions too (off by default: a child's background work is aborted when the child closes). The report is injected into the parent as an `eh.event` that wakes it, capped by `maxReportChars` (default `AGENT_REPORT_MAX_CHARS`, 16 000). The `subagentTasks` service (`list`, `get`, `stop`, `stopAll`, `subscribe`, `moveToBackground(toolCallId?)`, `send()`) serves UIs.
  - **`agent_output({ id, offset?, limit? })`** (`outputTool`) reads an agent's full final report by task id, name or child session id (works after a restart), paged by characters. **`agent_stop({ id })`** (`stopTool`) stops a running background agent. Both default on when `background` or `messageTool` is on; `boolean | { name }` rename or disable them.
  - **Agent messaging (Draft):** `send_message({ to, message })` (`messageTool`, on by default for `'inline'` / `'policy'`) addresses `main`, a task id, a child session id or a **name** (the optional `name` field of `agent`). A running agent gets the message at its next step as a framed `<agent-message>`; a finished resumable agent (`SubagentDefinition.resumable`, default `true`) is resumed on the same child session; a subagent can wake or steer `main`; messages are throttled (`messageLimits`) and a roster reminder lists addressable agents. Set `messageTool: false` to leave the tool set unchanged.
  - Constants: `AGENT_TOOL`, `SEND_MESSAGE_TOOL`, `AGENT_OUTPUT_TOOL`, `AGENT_STOP_TOOL`, `AGENT_REPORT_MAX_CHARS`, `AGENT_OUTPUT_PAGE_CHARS`, `AGENT_NAME_PATTERN`, `AGENT_MESSAGE_MAX_CHARS`, `AGENT_MESSAGE_INSTRUCTIONS`.
  
  See spec 20 and the subagents guide.

- [`602b60c`](https://github.com/viandwi24/eharness/commit/602b60cf56165372ddf9ff78d76347e3fec5c860) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/web`: `webFetch()` and `webSearch()`.
  
  - `webFetch(options?)` fetches one URL as Markdown: allow and deny lists, a refusal of private and local addresses (an injectable `resolveHost` extends it to DNS names), redirects reported as `REDIRECT:`, byte and character caps, an injectable `toMarkdown` and `fetch`. Page content is framed as `<untrusted-content source="web_fetch" url="…">` (`wrapUntrusted: false` opts out).
  - `webSearch({ search })` is provider-agnostic: you supply the search function; findings and sources are framed as untrusted content and its usage is charged to the turn.
  - Both tools are `metadata.risk: 'external'` and return `ERROR:` strings for failures. Default tool names are exported as `WEB_FETCH_TOOL` and `WEB_SEARCH_TOOL`; helpers `htmlToText`, `isPrivateHost`, `matchHost`.
  
  Known gap: without `resolveHost`, DNS names that resolve to private addresses are not refused. See spec 22 and the web guide.

## 0.6.0

### Minor Changes

- [`33888e8`](https://github.com/viandwi24/eharness/commit/33888e8e04fd1383c181e6f39a834f095dc71d68) Thanks [@viandwi24](https://github.com/viandwi24)! - Add `wrapPlugin(plugin, overrides?)`: compose a plugin through the public API.
  
  - Returns a normal plugin with the inner plugin's name, `version`, `provides`, `requires`, data
    parts and message kinds; intercept `setup`, `session` and any hook with a `next` that calls the
    inner implementation. Hook order and boot validation are unchanged.
  - `next.using(other)` runs another plugin's session phase, for per-request configuration of plugins
    configured at construction (e.g. a judge model for `approvalGuard()` resolved from `ctx.runtime`).
  - New types: `WrapPluginOverrides`, `WrapSessionNext`, `WrapHookOverride`, `WrapHookOverrides`,
    `WrapHookNext`. No changes when unused (spec 01 §2.1, ADR-0033).

### Patch Changes

- [`32c8ea0`](https://github.com/viandwi24/eharness/commit/32c8ea0e61a43368b0345c86e01262515c3bc801) Thanks [@viandwi24](https://github.com/viandwi24)! - Fix approvals combined with tools that have no `execute` (`externalTool()` and client tools).
  
  - An `approved` status (policy, `approval.risk`, a `tool.approve` hook or a session grant) now means
    "no human needed": the call parks as an external wait or a client call instead of showing up as a
    pending approval that can never be answered meaningfully.
  - After a `user-approval` is approved, an `externalTool()` call now parks its wait (the pending state
    is committed, then `start` runs) and `resolveWait()` continues the same message, instead of the
    turn ending `complete` with the call unanswered. Denials are unchanged.
  - Approved server calls of the same batch stay pending with `granted: true` (new optional field of
    `PendingState.approvals`) and run after the wait is resolved; `respond()` answers them itself.

## 0.5.0

### Minor Changes

- [`4ce60e9`](https://github.com/viandwi24/eharness/commit/4ce60e9f7e8f5eef107d40b5f0e1d0fd86921bc7) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/guard`: `approvalGuard({ model, policy?, … })` — an LLM judge on the
  approval chain (spec 15, ADR-0030).
  
  - **Tighten only:** returns `denied` (with a reason the model reads) or `user-approval`, never
    `approved`; with most-restrictive-wins it cannot loosen a policy, risk rule, hook or grant.
  - **Restricted view:** the judge sees the policy, user messages, the agent's earlier tool calls and
    the call under review — never tool outputs, assistant text, reasoning or instructions.
  - Read-risk fast path (`skipRisks`, `skipTools`, `onlyTools`), per-session verdict cache in plugin
    state (keyed by tool + SHA-256 of the canonical input; the answer per tool call id is recorded,
    so `respond()` re-validation never calls the judge), a consecutive-denial circuit breaker that
    escalates to a person, fail closed to `user-approval` when the judge errors or times out, and
    judge usage charged to the turn (budgets and the budget ledger see it).
  - The per-call record is reused only when tool name and verdict key match (a reused tool call id
    with another call is judged again); the verdict key covers the policy text and judge model id;
    a cached `allow` ignores later conversation context (use `cache.ttlMs`).
  - Exported texts `GUARD_*` and helpers `canonicalJson`, `verdictKey`.
  
  Core:
  
  - The `tool.approve` event gains `transcript()` (spec 11 §3.4): a lazy, restricted view of the
    conversation (user messages and tool calls only) for judges; new type `GuardTranscriptEntry`.
  - New warning `W_GUARD_UNAVAILABLE`.
  - **Type-level:** `WarningCode` gains a member; the `tool.approve` event gains a required
    `transcript` field (code that calls hooks by hand must pass it).
  
  - Plugin / app kind projections are tagged `providerOptions.eharness.core` on the model wire so the
    restricted transcript excludes them (not only string projections); the JSDoc and specs 11/15 state
    the remaining limits (app-projected text, such as group history blocks, appears as user text).

- [`52917d7`](https://github.com/viandwi24/eharness/commit/52917d73418d0003c0211db9815f99866fba5297) Thanks [@viandwi24](https://github.com/viandwi24)! - Cross-session budget ledger (spec 12 §4.1, ADR-0029).
  
  - New optional port `BudgetLedger` (`reserve`, `commit`, `release`, `record`, `check`) configured
    as `budget.ledger: { adapter, scopes, estimate?, reservationTtlMs?, onError? }`. Before every
    model call (wrap-up step included) the core reserves an estimate on the turn's app-defined
    scopes, atomically; after the step it commits the actual cost (0 when the provider reported no
    usage). A refused reservation stops the turn with `'cost-cap'` before the call (`W_BUDGET` with
    `details.scope: 'ledger'`, `ledgerScope`). Nested usage (`ctx.turn.addUsage`, the compaction
    summarizer and flush, a manual `compact()`) is recorded with idempotent keys.
  - Fails closed: a failing ledger before a call ends the turn with `'error'` (`EH_STORAGE`,
    `details.operation: 'budget-ledger'`); `onError: 'continue'` runs the step unreserved with the
    new warning `W_BUDGET_LEDGER_FAILED`. Commit / record failures are warnings.
  - `memoryBudgetLedger({ limits })` in `eharness/storage/memory` (static limits, no periods),
    `budgetLedgerConformance(factory)` in `eharness/testing`, and the `estimateStepCostUsd()` helper
    (context tokens × input price + `maxOutputTokens`, default 4 096, × output price). New types
    `BudgetLedgerConfig`, `BudgetReservation`, `BudgetScopeStatus`, `BudgetEstimateEvent`.
  - **Type-level change:** `W_BUDGET` `details.scope` gains `'ledger'` (code that matches
    `'turn' | 'session'` exhaustively must add it); `WarningCode` gains `W_BUDGET_LEDGER_FAILED`.
    No new stop reason. Without `budget.ledger`, behaviour, warnings and storage are unchanged.
  
  A failed `commit` stays queued and is retried before the next reservation and at turn end; if it
  still fails the spend is charged with `record` instead of being lost.

- [`294f7e6`](https://github.com/viandwi24/eharness/commit/294f7e602e8b39d9e32cb151eb7acb660bd5a5dc) Thanks [@viandwi24](https://github.com/viandwi24)! - External waits: park a turn on a result that arrives later, in any instance (spec 11 §4.2, ADR-0027).
  
  - New `externalTool({ description, inputSchema, outputSchema?, start?, timeoutMs?, onTimeout?, metadata? })`:
    an AI SDK tool without `execute` whose result comes from outside (a webhook, a job, another
    agent, a person). `start` runs after the pending state is committed (stable `waitId` =
    `w_<toolCallId>`; a fast callback finds the wait pending; a throwing `start` is
    `W_HOOK_FAILED` and the wait stays parked until its timeout; a start a crash left undispatched,
    `PendingExternal.started: false`, is dispatched again after `recovery.staleMs` when a session
    opens or `expireWaits()` runs). The turn stops `'tool-pending'` and holds nothing.
  - New `session.resolveWait(waitId, { output } | { errorText })`: validates against `outputSchema`
    (`EH_INVALID_INPUT`, `details.reason: 'invalid-result'`), applies `tool.after` and the output
    limits, and records the result with a compare-and-set; the first result wins, a replay is
    `already-resolved`. When nothing is left open the **same** assistant message continues like a
    `respond()` continuation. New `session.expireWaits(now?)` (sweepers) and `session.pendingWaits()`;
    `respond({ externals })` answers waits together with approvals and client tool calls.
  - Timeouts: `timeoutMs` / `timeoutAt` with an explicit `onTimeout` result (default
    `WAIT_TIMED_OUT`), applied by a timer in the holding process, by a durable `wait-timeout` inbox
    item (`availableAt`, any instance) or by `expireWaits()`; all go through the same
    compare-and-set. New input with `onNewInput: 'deny'` answers open waits with
    `WAIT_CANCELLED_NEW_INPUT` (results already recorded are kept).
  - Clients cannot resolve external waits: `handleChatRequest` ignores such answers and
    `respond({ toolOutputs })` for an external call is `EH_INVALID_INPUT` (`'wrong-kind'`).
  - **New pending kind / type-level changes:** `PendingState` gains `v` (`2`, written by 0.5; no `v`
    is the 0.3 / 0.4 shape, an unknown `v` authorizes nothing), the optional `externals` array
    (`PendingExternal`) and optional `timeoutAt` / `onTimeout` on `clientTools[]`. `InboxItemInput`
    gains the kind `wait-timeout` and `SessionEvent` gains `wait-resolved` (exhaustive switches must
    add them; the `inbox-enqueued` / `inbox-dead` events can carry the new kind).
    `EH_INVALID_INPUT` `details.reason` gains `'wrong-kind'` and `'invalid-result'`. New exports:
    `externalTool`, `ExternalToolDef`, `WaitStart`, `WaitStartEvent`, `ResolveWaitResult`,
    `PendingExternal`, `WaitResult`, `WaitTimeoutResult`, `WAIT_TIMED_OUT`,
    `WAIT_CANCELLED_NEW_INPUT`. `HarnessSession` gains three methods (custom implementations of the
    interface must add them).
  - Stored pending state is now written with `v: 2`; sessions that never use `externalTool` are
    otherwise unchanged.
  - `respond({ externals })` outputs are validated against `outputSchema` like `resolveWait()`
    results; an `onTimeout.output` that fails `outputSchema` falls back to `WAIT_TIMED_OUT` with a
    `W_HOOK_FAILED` warning; a `wait-timeout` item that is not due yet is ignored.

- [`38d027a`](https://github.com/viandwi24/eharness/commit/38d027a3646650290bb8d870b28739b433e8a307) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/group`: `groupChat({ botId, … })` and `routeGroupMessage()` — multi-party
  chat support (spec 16, ADR-0031).
  
  - **Should-respond gating:** `requireMention` (default), `mentionsBot` / `replyToBot` channel
    facts, `mentionPatterns`, `replyCountsAsMention`, a custom `shouldRespond` hook; bot authors are
    ignored unless `allowBots`.
  - **Pending history:** gated-out messages are stored as the `group.message` kind (`model: 'omit'`)
    and the newest `historyLimit` (default 20) are merged, framed as data, into the next answering
    user message — exactly once, in order.
  - **Speaker metadata** in `metadata.group` (needs `acceptClientMetadata: true`) and a visible
    speaker line; **bot-to-bot anti-loop** (`maxBotTurns` per window) derived from stored history,
    safe across instances.
  - Exported texts `GROUP_HISTORY_PREAMBLE`, `GROUP_SPEAKER_PREFIX`. No core change.
  
  Review fixes: pending history is tracked with `metadata.group.consumed` ids (a gated message stored
  while a turn runs is no longer lost; a collected burst carries one history block); typed
  `[group] ` speaker lines are neutralised; docs note that `acceptClientMetadata: true` lets clients
  forge `metadata.group`.

- [`b3488dc`](https://github.com/viandwi24/eharness/commit/b3488dcef3cb786669dd4bd03c2928f5a0cbeae1) Thanks [@viandwi24](https://github.com/viandwi24)! - Inbox retries and dead-letter: poison items no longer cycle forever or block their session
  (spec 05 §12 rules 11–15, ADR-0026). Opt-in: without `inbox.retry` behaviour and storage are
  those of 0.4.
  
  - New config `inbox.retry { maxAttempts?, backoff?: { type?: 'fixed' | 'exponential', delayMs?,
    maxDelayMs?, jitter? }, nonRetryable? }` (defaults: unlimited attempts, exponential from 1 s
    capped at 60 s with full jitter, `EH_INVALID_INPUT` non-retryable) and `inbox.onDeadLetter(item)`
    (a throw is `W_HOOK_FAILED`). Attempts are counted at claim (a crashed holder counts); the core
    releases deferrals with `uncount` so a long turn of another instance never consumes attempts,
    and failed attempts with a backoff and `lastError`. An item past `maxAttempts`, or failing with a
    non-retryable error (including a stored input that no longer validates), is dead-lettered and
    reported: session event `inbox-dead`, warning `W_INBOX_DEAD_LETTER`.
  - `InboxAdapter` gains optional `deadLetter`, `redrive`, `listDead`, `stats` and `release(ids,
    opts?)` options (`delayMs`, `uncount`, `lastError`); `InboxItem.lastError?`; every
    `InboxItemInput` member gains `availableAt?` (a durable timer: invisible and holding nothing back
    until due). New types `DeadInboxItem`, `InboxReleaseOptions`, `InboxStats`,
    `InboxRetryOptions`, `InboxBackoffOptions`. `memoryInbox()` implements all of it;
    `inboxAdapterConformance` gains `requireRetry`, `requireDeadLetter` and `requireStats`.
    `examples/postgres-inbox.ts` adds the columns (in-place `ALTER TABLE … ADD COLUMN IF NOT
    EXISTS` upgrade of a 0.4 table) and recreates `eh_inbox_claim`.
  - **Breaking for custom `InboxAdapter`s (only when `inbox.retry` is used):** the new members are
    optional and 0.4 adapters keep compiling and working without `retry`, but `retry.maxAttempts`
    is only safe with an adapter that honours the `release` options and `availableAt` (pass
    `inboxAdapterConformance(…, { requireRetry: true })`); an adapter without `deadLetter` acks dead
    items after `onDeadLetter` ran.
  - Type-level: `SessionEvent` gains `inbox-dead` (exhaustive switches must add it); `WarningCode`
    gains `W_INBOX_DEAD_LETTER`; `W_INBOX_FAILED` gains the operation `deadLetter`.
  
  - `InboxReleaseOptions` gains `owner`: the core always passes it, and an adapter releases only items
    still claimed by that owner (a stale holder can no longer free a newer owner's claim or undo its
    attempt). `memoryInbox` and the Postgres example honour it; the conformance suite checks it with
    `requireRetry`. Without `deadLetter`, an item whose `onDeadLetter` threw is released with a
    backoff delay instead of spinning.

- [`ebcd257`](https://github.com/viandwi24/eharness/commit/ebcd2575fd70a906953af11528cb9aa516fce466) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/openapi`: `openApiTools(spec, options)` turns an OpenAPI 3.0/3.1 JSON
  document into a tool source — include/exclude by method, path, tag and operationId, app-supplied
  `baseUrl` and `headers` (the spec's `servers` are ignored by default), risk from the HTTP method,
  local `$ref` resolution with a recursion guard, schema summarization, a tool-count guard and
  deferral; failures return as error strings. Also `riskFromMethod()` (spec 17, ADR-0032).
  
  Review fixes: `schema.maxSchemaBytes` (default 16 384) bounds the serialized schemas of a tool, so
  fan-out `$ref`s cannot blow up the tool list (cut subschemas are logged once); path parameter
  values with `.` / `..` segments (also percent-decoded) or encoded `/` / `\` are rejected.

- [`9ff66a8`](https://github.com/viandwi24/eharness/commit/9ff66a8223827363750fbddc381f78e73cb6919c) Thanks [@viandwi24](https://github.com/viandwi24)! - Request-scoped client tools and page context (spec 11 §7.1, ADR-0028): a request can declare
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

- [`a70b6b1`](https://github.com/viandwi24/eharness/commit/a70b6b1f300b43154626b827283ea6771bf92ee3) Thanks [@viandwi24](https://github.com/viandwi24)! - Tool risk `'external'`, tighten-only MCP annotations and tool traits (spec 11 §3.2, ADR-0025).
  
  - `ToolRisk` gains `'external'` (an effect outside the system: email, third-party post, payment).
    An MCP tool whose server sends `openWorldHint: true` and no app risk is `'external'`;
    `destructiveHint: true` still wins as `'destructive'`; `readOnlyHint` never lowers a risk and no
    MCP spec defaults are applied. Route it with `approval.risk: { external: 'user-approval' }`.
  - New `toolTraits(metadata)` export (`ToolTraits`, `ToolHints` types): `{ risk?, idempotent?,
    hints? }`. `idempotent` comes only from app metadata (`tool({ metadata: { idempotent: true } })`);
    `idempotentHint` is reported in `hints` only.
  - The `tool.approve` event gains `idempotent?` and `hints?`; `ApprovalDecision` and
    `PendingState.approvals[]` gain `idempotent?`.
  - `mcpServer({ risk })` (`eharness/mcp`, type `McpRiskFunction`): a trusted risk for a server's
    tools, as a constant or a function per server tool; invalid values throw `EH_CONFIG_INVALID`.
  - **Type-level change:** `ToolRisk` gaining a member breaks exhaustive `switch` statements and
    `Record<ToolRisk, …>` objects, which must add `external`. Behaviour of tools without the new
    hints or metadata is unchanged.
  - Fix: when AI SDK re-validates an approved call (the `respond()` continuation), the approval
    function now reads the tool's traits from the tool itself (the stored call carries no
    `toolMetadata`). Before, the risk fell back to `unknown` there, so `approval.risk: { unknown:
    'denied' }` denied calls a person had just approved.

### Patch Changes

- [`0caa2f4`](https://github.com/viandwi24/eharness/commit/0caa2f432d9411ca76d3d0f51704331b603d8187) Thanks [@viandwi24](https://github.com/viandwi24)! - Fix: an approved call of a tool without `execute` (a request-scoped client tool, or a client tool
  registered on the server) now parks as a client call instead of ending `complete` with an
  `Interrupted:` error. The approving `respond()` / `handleChatRequest` stops `'tool-pending'` with
  the call in `pending.clientTools` (with `waitId` / `timeoutAt` / `onTimeout` when `timeoutMs` is
  set) and no model step; the client's output streams into the same message. Approved server calls
  of the same batch wait until the client answered. Denials are unchanged.
  
  Request-scoped client tools hardening: `__proto__`, `constructor` and `prototype` are rejected as
  names and the per-turn tool record has no prototype; escaped page context descriptions count
  toward `pageContext.maxChars`; a schema property named `$ref` is no longer rejected, `$dynamicRef`
  and `$recursiveRef` are; descriptions are cut without splitting surrogate pairs.

## 0.4.0

### Minor Changes

- [`189e140`](https://github.com/viandwi24/eharness/commit/189e1400da00c87c1b3fde141a82301a4767c5b4) Thanks [@viandwi24](https://github.com/viandwi24)! - Cross-process abort (spec 05 §9.1, ADR-0021).
  
  - New `session.requestAbort(reason?)` → `{ target: 'local' | 'remote' | 'idle' | 'unsupported' }`.
    `session.abort()` keeps its signature and now also stops a turn running in another instance when
    no turn of the session runs locally and the `StateAdapter` implements `setIf`. The owning
    instance stops at its next step boundary or heartbeat tick (a running tool's `abortSignal` fires)
    with `stop: 'aborted'`, exactly like a local abort.
  - New persisted field `state.core.abortRequest` (turn-scoped: a late Stop never aborts the next
    turn); new option `recovery.abortPollMs` (default 2 000 ms, `0` = off); new warning
    `W_ABORT_UNSUPPORTED`; new types `AbortRequest`, `AbortRequestResult`.
  - Behaviour: while a turn runs, the owner's state writes (heartbeat, compaction, end of turn) use
    `setIf` when available and merge a foreign `abortRequest` on conflict; a running turn reads the
    state at most once per `abortPollMs`.
  - Type-level: `HarnessSession` gains `requestAbort()` (custom implementations and mocks must add it).

- [`4524d47`](https://github.com/viandwi24/eharness/commit/4524d477dda5b7ba07f22477c406cfc86ce2352a) Thanks [@viandwi24](https://github.com/viandwi24)! - Durable inbox: queue, steer, wake, collect and abort across instances (spec 05 §12, ADR-0024).
  
  - New optional port `InboxAdapter` (`storage.inbox`, also `SessionOptions.storage.inbox`) with
    `enqueue` / `claim` / `ack` / `release` and optional `notify` / `subscribe` / `pending`;
    `memoryInbox()` in `eharness/storage/memory`; `inboxAdapterConformance` in `eharness/testing`.
    A Postgres adapter (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`) is an example
    (`examples/postgres-inbox.ts`), not a dependency.
  - New `session.enqueue(input, { mode: 'queue' | 'steer' | 'collect', collect? })` →
    `{ inboxId, target: 'local' | 'remote' }`: with an inbox the input is stored durably and
    applied by the instance holding the session (at-least-once delivery, deduplicated by id);
    without one it is applied in this process. `send()` keeps its 0.3 semantics.
  - `ifBusy: 'collect'` with `SendOptions.collect` (`quietMs` 1 500, `maxWaitMs` 10 000,
    `maxItems` 20): a burst of inputs becomes one user message and one turn (also without an
    inbox). New config `inbox: { pollMs?, claimTtlMs?, collect? }`.
  - With an inbox: `requestAbort()` / `abort()` reach a turn running in another instance through
    an `abort` item (the state request stays the fallback); `inject(…, { wake: true })` while
    another instance runs the turn hands the wake to it.
  - New session events `inbox-enqueued` and `inbox-drained`; new warning `W_INBOX_FAILED`;
    persisted additions `metadata.eharness.inboxId` / `collected`, `data-eh.input` `inboxId`,
    `state.core.inboxDelivered`. New types `InboxAdapter`, `InboxItem`, `InboxItemInput`,
    `SerializedInput`, `CollectOptions`, `EnqueueOptions`, `EnqueueResult`.
  - Type-level: `SendOptions.ifBusy` gains `'collect'`; `SessionEvent` gains two members
    (exhaustive switches must add cases); `HarnessSession` gains `enqueue()` (custom
    implementations and mocks must add it).

- [`bf3ee98`](https://github.com/viandwi24/eharness/commit/bf3ee981a34f1871772ab7660bc1684e8e499d3b) Thanks [@viandwi24](https://github.com/viandwi24)! - Behaviour, type-level and model-visible changes of the 0.4.0 hardening — check these when upgrading.
  
  **Behaviour**
  
  - The turn stream (`run.stream`, `attach()`, `toResponse()`) ends only after the turn is persisted and the session is free: a client that saw `finish` can `send()` without hitting `EH_SESSION_BUSY` from that turn. New `SendOptions.ifBusy: 'wait'` (`send()` and `respond()`: wait for the running turn and the queue, FIFO, honours `abortSignal`) and `session.idle()`.
  - `handleChatRequest` no longer throws `EH_SESSION_BUSY`: it returns a failed run (`error.code: 'EH_SESSION_BUSY'`) whose `toResponse()` / `pipeTo()` answer **409** with `{ error: { code, message } }`. Routes that caught the exception should handle the 409 (or pass `{ ifBusy: 'wait' }`).
  - New `inputFiles` agent option: file URLs of user input outside `['data:', 'https:']` (e.g. `http:`) and `data:` URLs over 20 MB are now `EH_INVALID_INPUT`. Opt in with `inputFiles: { protocols: ['data:', 'https:', 'http:'] }`.
  - Out-of-range numeric options (`loop.maxSteps: 0`, `compaction.summarizeAt` outside (0, 1), negative budgets, …) now throw `EH_CONFIG_INVALID` at `defineHarnessAgent`.
  - Summarizer usage now counts toward `TurnResult.usage`, `costUsd`, `state.core.usage` and budgets (manual `compact()` charges the session). A used-up budget skips compaction (`W_BUDGET`, `details.compaction: true`); a compaction that uses up the budget stops the turn with `'cost-cap'`.
  - `messageAdapterConformance` is stricter (an upsert must replace, not merge; `fromId` between stored ids; `beforeId` without `limit`). Third-party adapters may now fail it — they were wrong before.
  - Chunk order: the transient `data-eh.status { state: 'tool' }` chunk may now arrive before the step's `start-step` (AI SDK ≥ 7.0.124 internals); it never changes the message.
  
  **Types**
  
  - `HarnessSession` gains `idle()` (custom implementations and mocks must add it); `SendOptions.ifBusy` gains `'wait'` (exhaustive switches must add it); `compaction.prompt` hooks receive the messages being summarized as `out.messages`.
  
  **Model-visible**
  
  - `read_file` (`eharness/filesystem`) gains the input `charOffset`. A line longer than the window ends with `(Line <n> continues; use offset=<n> charOffset=<c>.)`, so very long lines (minified code, evicted single-line JSON outputs) are fully readable.
  - `grep` accepts only a conservative safe subset of regular expressions: at most one variable-width quantifier in the whole pattern (`*`, `+`, `?`, lazy variants, `{n,}`, `{n,m}` with m > n; a fixed `{n}` is fine), no quantified groups (`(…)` / `(?:…)` followed by any quantifier), no backreferences or lookarounds, at most 512 characters. `foo|bar`, `import .* from`, `^\s*export`, `a.{0,90}b` work; `.*foo.*bar`, `(\d+\.)+\d+`, `(ab){3}` are refused with `ERROR: invalid pattern: …` (search for a literal, or split into simpler searches). Only the first 2 000 characters of a line are matched; a line cut at 300 characters ends with ` (match at charOffset=<c>)`. Adapters that push `grep` down should apply the same rule or use a linear-time engine (RE2).
  - A file of an earlier turn whose URL can no longer be downloaded (e.g. an expired link) is replaced on the wire by the new fixed text `FILE_UNAVAILABLE` (`[file unavailable: <mediaType> <filename>]`) and the step is retried, instead of failing every later turn.
  - A compaction summary cut at `maxSummaryTokens` (`finishReason: 'length'`) is a compaction failure (`W_COMPACTION_FAILED` / `EH_COMPACTION_FAILED`, `details.reason: 'length'`).

- [`7350216`](https://github.com/viandwi24/eharness/commit/73502168db945edef85a421c7b5906279561f605) Thanks [@viandwi24](https://github.com/viandwi24)! - Durable inbox delivery guarantees (spec 05 §12, ADR-0024):
  
  - A durable steer that waits for a long step is delivered once: the holder renews the claims of the items it holds, and a running turn takes a steer once per inbox id.
  - No item is lost when a process dies between a state write and the save of the item's effect: send items and steers are deduped by the `inboxId` of their stored messages only; `state.core.inboxDelivered` now lists `wake` items only, written with the wake turn's end-of-turn state write (a wake is acked after it).
  - Id order holds with two live holders: the items after a started unit stay claimed until its turn commits or ends.
  - `InboxAdapter.claim` contract (checked by `inboxAdapterConformance`): head of line — never return an item behind an older item of the session that another owner holds — and renewal — a claim by the owner extends the claims it already holds (not returned again, `attempts` unchanged). `memoryInbox()` implements both and `pending()` lists only sessions whose oldest item is claimable; custom adapters must follow (see `examples/postgres-inbox.ts`).

- [`295dd21`](https://github.com/viandwi24/eharness/commit/295dd21ec45c307a8d80f49045a1eb4de1cb14f3) Thanks [@viandwi24](https://github.com/viandwi24)! - New subpath `eharness/memory`: the `memory()` plugin gives agents file-based long-term memory on
  the `fs` service — six tools (`memory_view`, `memory_create`, `memory_str_replace`,
  `memory_insert`, `memory_delete`, `memory_rename`) with the command contract of Anthropic's memory
  tool, application-chosen roots resolved per turn (read-only or writable), pinned files in the turn
  reminder (prompt-cache safe), size limits, optimistic concurrency and an `onWrite` audit callback.
  `executeMemoryCommand()` runs one command directly, and the `tool` option lets the application
  supply its own (e.g. provider-defined) memory tool. Exports `MEMORY_PROTOCOL`, `PINNED_PREAMBLE` and `MEMORY_TOOLS`.
  
  `FileSystem` gains an optional atomic `move(from, to, { ifVersion })` (`MoveResult`); `memoryFs`
  implements it and `fileSystemConformance` checks it (`requireMove`).
  
  Model-visible: six new tool names when the plugin is used.

- [`ecc56aa`](https://github.com/viandwi24/eharness/commit/ecc56aa20618aa5a1911f7a4dc3c773b431f6493) Thanks [@viandwi24](https://github.com/viandwi24)! - `send(input, { output, ifBusy: 'steer' | 'collect' })` is now a run error `EH_INVALID_INPUT` (`details.reason: 'output-with-steer-or-collect'`), whether the session is busy or not, instead of silently ignoring `output` (a steer or a collected input joins another turn; spec 05 §3.3 rule 9).

- [`7335767`](https://github.com/viandwi24/eharness/commit/7335767945e60e7cd225b84db9fa542111c2f76a) Thanks [@viandwi24](https://github.com/viandwi24)! - Raised minimum peer versions: `ai@^7.0.127` (was `^7.0.123`) and the optional `@ai-sdk/mcp@^2.0.66` (was `^2.0.63`) — the locked, tested versions. UI chunk order is public API and older 7.0.x patches order the transient `data-eh.status { state: 'tool' }` chunk differently around `start-step`; upgrade `ai` (and `@ai-sdk/mcp` if you use `eharness/mcp`) together with eharness 0.4.

- [`2360d01`](https://github.com/viandwi24/eharness/commit/2360d01aa49c86f518aa5a534899016330600ddf) Thanks [@viandwi24](https://github.com/viandwi24)! - Pre-compaction flush. New chainable hook `compaction.before` (`CompactionBeforeEvent` → `CompactionBeforePatch`) can request a `flush`: one bounded, internal `generateText` turn over the current conversation with whitelisted tools, run right before the summarizer so the agent can save facts (e.g. into memory files). Calls that would need approval are auto-denied (`FLUSH_APPROVAL_DENIED`, reported to `approval.decided`). The flush leaves no trace in the model's context; a new model-invisible core kind `eh.flush` (`FlushPayload`: trigger, prompt, model, steps, tool names/statuses, usage, cost, error) is stored before the marker and streamed once as a transient `data-eh.flush` part. Its usage is charged to the turn and budgets with `source: 'compaction-flush'`, including the completed steps of a flush that then fails (the `eh.flush` record of a failed flush carries their steps, tool statuses and usage). New warning `W_COMPACTION_FLUSH_SKIPPED` (the flush does not fit the window, or overflow recovery without a larger flush window); a failing flush is `W_HOOK_FAILED` with `details.phase: 'flush'` and compaction continues. `eharness/memory`: new option `memory({ flushOnCompaction: true | { prompt } })` with `MEMORY_FLUSH_PROMPT` and `MEMORY_FLUSH_TOOLS`; the flush prompt also carries the memory roots and pinned files (the flush call has no turn reminder). Type-level: `HarnessHooks` gains `compaction.before`; `HarnessKindTypes` / `HarnessDataTypes` gain `'eh.flush'` (exhaustive switches over core kinds must add a case).

- [`cd4d07c`](https://github.com/viandwi24/eharness/commit/cd4d07cf53a0daf6e255b28b5daa60080e9c1ce5) Thanks [@viandwi24](https://github.com/viandwi24)! - Context pruning, compaction thrash detection and skill versions (0.4.0).
  
  - New `compaction.prune` (off by default; `{}` turns it on with `keepTurns: 2`, `minChars: 2_000`): view-only pruning of old tool outputs before summarizing. Tool outputs of completed turns older than `keepTurns` and larger than `minChars` are replaced in the request by `TOOL_OUTPUT_PRUNED` (`[output of <tool> pruned: <n> chars]`) or a pure `replaceWith(part: ToolResultPart)`; `exclude` lists tools never pruned. Stored messages never change, errors and denials are never pruned, tool calls keep their results. The summarizer runs only if the pruned context is still above `summarizeAt`. `ContextStats` gains `pruned?: { outputs, chars }`. New exports: `PruneConfig`, `TOOL_OUTPUT_PRUNED`.
  - **Behaviour change:** compaction thrash detection, `compaction.thrash` (default on, `{ withinSteps: 2 }`). When a second automatic (mid-turn or overflow-recovery) compaction within 2 model steps of the previous one runs (or is skipped as no-gain) and the context is still above `summarizeAt` afterwards, the turn now stops with the new stop reason `'context-thrash'` (warning `W_CONTEXT_THRASH`, an `eh.notice` with code `EH_CONTEXT_THRASH`) instead of continuing. Compactions at the start of a turn do not count, and a second compaction that gets the context below `summarizeAt` is not a thrash, so ordinary turns behave as in 0.3. Set `thrash: false` for the 0.3 behaviour.
  - **Type-level:** `StopReason` gains `'context-thrash'`, `HarnessNoticeCode` gains `'EH_CONTEXT_THRASH'`, `WarningCode` gains `'W_CONTEXT_THRASH'`. Exhaustive `switch` statements over `StopReason` must add a case (same note as `'stuck'` in 0.3).
  - `SkillMeta.version` (also `SkillDoc`, `Skill`): read from `SKILL.md` frontmatter `version:` as a string (`1.0` stays `"1.0"`), validated (1–64 printable characters; an invalid version makes the skill invalid). **Model-visible:** `load_skill` shows a `version:` line right after `description` when the skill has one; nothing changes for skills without it, and the skills index never shows versions. The `skill.load` hook event gains `version`. `skillSourceConformance` checks that `version` survives `list()` and `load()` (opt out with `{ version: false }`).
  - **Behaviour change (skills):** a `version:` key in `SKILL.md` frontmatter is no longer passed through in `meta.version`; it is read into `SkillMeta.version` (string) instead. Code that read `meta.version` must read `version`.
  - **Behaviour change (skills):** an invalid `version` (empty, not a scalar, longer than 64 characters or with non-printable characters) now makes the skill invalid, so it is skipped with `W_SKILL_SOURCE_FAILED` and missing from the index (as for an invalid `name` or `description`); before 0.4 any value was accepted as meta.
  - **Behaviour change (testing):** `skillSourceConformance` checks versions by default — custom skill sources that drop or rename `version` now fail it; opt out with `{ version: false }`.

- [`b80c0b1`](https://github.com/viandwi24/eharness/commit/b80c0b1952c3abbe6f8e65de8d81ebe7cfab4b2b) Thanks [@viandwi24](https://github.com/viandwi24)! - Structured final output (spec 05 §3.3, ADR-0023).
  
  - New `SendOptions.output = { schema, mode?: 'tool' | 'native', maxRetries?, toolName?, description? }`
    (also for `respond`, `regenerate`, `edit`): the turn's final answer is validated against the
    schema, invalid or missing answers are retried (default 2 retries) and the valid answer is
    returned as `TurnResult.output`, typed from the schema (zod, `jsonSchema<T>()`, Standard Schema).
    Tool mode (default) adds a `final_answer` tool for that turn, appended last in the tool order;
    native mode uses AI SDK `Output.object` on `streamText`. Standard Schemas need JSON Schema
    support (else `EH_INVALID_INPUT`, `details.reason: 'output-schema'`).
  - New persisted part `data-eh.output { value, mode, attempts }`, new `metadata.eharness.output
    { ok, attempts }`, new warning `W_OUTPUT_INVALID`, new fixed texts `FINAL_ANSWER_DESCRIPTION`,
    `FINAL_ANSWER_RECORDED`, `OUTPUT_INSTRUCTION`, `OUTPUT_RETRY`; new types `OutputSpec`,
    `SendOptionsWithOutput`, `OutputPartData`. Retries are delivered as `data-eh.input` with source
    `plugin:eh.output` and count as continuations (`loop.maxContinues` / `maxIdleContinues`).
  - **Type-level:** `StopReason` gains **`'output-invalid'`** — exhaustive `switch` statements must
    add a case (as with `'stuck'` in 0.3 and `'context-thrash'` in this release). `HarnessRun` gains a
    second type parameter `O` (defaulted to `never`, so `HarnessRun<M>` is unchanged) and
    `TurnResult` a second type parameter `O` (default `unknown`) with the optional field `output`.
    `HarnessSession` methods gain typed overloads (custom implementations stay assignable).
  - Turns without `output` are unchanged (same wire, same stored messages).

### Patch Changes

- [`bf3ee98`](https://github.com/viandwi24/eharness/commit/bf3ee981a34f1871772ab7660bc1684e8e499d3b) Thanks [@viandwi24](https://github.com/viandwi24)! - Hardening fixes from the 0.3.1 audit (no action needed; behaviour and type changes are listed in the separate minor changeset).
  
  - A cold session loads its state and messages exactly once, even when `stats()`, `inject()` and `send()` race; plugin state set in `session.start` and the user message are never lost.
  - `inject(…, { deliver: 'next-step' })` during turn preparation is delivered once at step 0 and reloads identically.
  - A steer that arrives during the last budgeted step is no longer swallowed by the max-steps wrap-up step; it becomes a queued turn.
  - `messages({ limit })` keeps paging past messages hidden by `regenerate()` / `edit()`, honours rewinds on cold instances, and never loops on an adapter that ignores `beforeId`.
  - `agent.session(id)` while the previous instance of that id is closing waits for the close (no false `EH_TURN_INTERRUPTED`, one writer); `agent.close()` also waits for such closing instances.
  - A turn that fails before its commit point reverts only the state its own hooks changed; `clearGrants()` and other plugins' `ctx.state` changes made meanwhile are kept. A failed commit-point state write never leaves a phantom `activeTurn` for a later write; a CAS conflict reloads the other instance's state instead of overwriting it.
  - Message ids no longer drift ahead of the clock when many ids are generated in one millisecond.
  - The default warning handler's dedupe set is bounded (1 000 keys).
  - The guard shrinks JSON-escape-heavy tool outputs instead of failing with `EH_CONTEXT_OVERFLOW`; head + tail truncation never splits an emoji (surrogate pair).
  - `describeError` passes on the provider's message only for AI SDK `APICallError` / `StreamProviderError`, with URLs, query strings and key-like tokens redacted and the text capped at 300 characters; other errors with a status read `HTTP <status>`.
  - An unknown status returned by an approval policy or `tool.approve` hook (e.g. a typo) now denies the call (fail closed).
  - `todos()`: the list survives a restart followed by a compaction; a `todo_write` denied by approval no longer changes the list.
  - Skills: `name: 007` / `description: 1.0` keep their raw text.
  - New, additive: `toolErrorText` agent option maps thrown tool errors (default `String(error)`, which may carry connection strings or tokens) — identically in the UI, storage and the model wire; `handleChatRequest(session, body, { actor })` passes the actor to `approval.decided`; exports `ChatRequestOptions`, `InputFilesConfig`, `ToolErrorTextFn`, `FILE_UNAVAILABLE`.
  - devDependencies `ai@7.0.127`, `@ai-sdk/mcp@2.0.66` (the peer floors are raised to these versions, see the peer-floor changeset).

## 0.3.1

### Patch Changes

- [`5c150da`](https://github.com/viandwi24/eharness/commit/5c150da69a30ba4ee01ea4db35a889a3ce3aeebb) Thanks [@viandwi24](https://github.com/viandwi24)! - Pricing tiers: the highest matching tier now wins regardless of array order (`computeCost`, and
  turn cost with a `models` record whose `pricing.tiers` are not sorted). Also clarifies TSDoc:
  `'cost-cap'` includes USD budgets, `ModelInfo.maxOutputTokens` is informational, and pending
  approval `input`/`risk` are absent in state written before 0.3.

## 0.3.0

### Minor Changes

- [#9](https://github.com/viandwi24/eharness/pull/9) [`ca0ba6e`](https://github.com/viandwi24/eharness/commit/ca0ba6ed63d2123f051aa54080ede3f4b053d3b7) Thanks [@viandwi24](https://github.com/viandwi24)! - **New: risk-based approval and approval decisions** (spec 11 §3.2–3.3, ADR-0017):
  
  - Tools declare a risk in AI SDK metadata: `tool({ metadata: { risk: 'read' | 'write' | 'destructive' } })`;
    MCP tools with `destructiveHint` are `'destructive'` (`readOnlyHint` is ignored). New exported
    type `ToolRisk`.
  - `approval.risk` maps a risk (or `unknown`) to an approval status, combined most-restrictive-wins
    with the policy, hooks and grants. `tool.approve` hooks receive `risk`.
  - Pending approvals (`TurnResult.pending`, `state.core.pending`, `pending` events) now include the
    tool `input` and `risk`.
  - New hook `approval.decided` receives every automatic decision (`by: 'policy' | 'risk' | 'grant' |
    'plugin:<name>'`), every `respond()` answer (`by: 'user'`) and new-input denials
    (`by: 'new-input'`), for audit logs and approval inboxes.
  - `respond({ approvals: [{ …, actor: { id, name } }] })` records who answered; it is passed to
    `approval.decided` and never stored or sent to the model.

- [#9](https://github.com/viandwi24/eharness/pull/9) [`b9c7d89`](https://github.com/viandwi24/eharness/commit/b9c7d89b1347ae1d7933449b80c59e587bf06f35) Thanks [@viandwi24](https://github.com/viandwi24)! - **New: model catalog, cost and USD budgets** (spec 12, ADR-0016):
  
  - `defineHarnessAgent({ models })` — a record keyed by model id, or a function — gives each model's
    `contextWindow`, `maxOutputTokens` and `pricing` (USD per 1M tokens: input, output, cache read,
    cache write, reasoning, context tiers). The context window is taken from it when `contextWindow`
    is not set.
  - `modelsDevCatalog(json)` converts the models.dev database (fetched by your app); `lookupModel`
    and `computeCost` are exported.
  - Every turn records its estimated cost as `costUsd` in `TurnResult.usage`,
    `metadata.eharness.usage`, `data-eh.usage`, `StepEndEvent.costUsd` and `state.core.usage` (all
    additive, absent when nothing was priced).
  - `budget: { maxTurnUsd, maxSessionUsd, warnAt }` stops the turn with `'cost-cap'` when a budget
    is used up; warnings `W_BUDGET` and `W_MODEL_UNPRICED`.
  - `ctx.turn.addUsage(usage, { model | costUsd, source })` prices nested usage (subagents); a plain
    string `source` still works.

- [#9](https://github.com/viandwi24/eharness/pull/9) [`f3716ec`](https://github.com/viandwi24/eharness/commit/f3716ec2de72fe60337e74d42eb295bdc6499334) Thanks [@viandwi24](https://github.com/viandwi24)! - **Long-running turns** (ADR-0015, spec 05 §3.1–3.2):
  
  - **BREAKING (defaults):** `loop.maxSteps` defaults to 500 (was 50); `loop.maxTurnOutputTokens` and
    `loop.maxContinues` default to none (were 100_000 and 3). Migration: set them explicitly to keep
    the old limits.
  - **New:** when the step budget runs out, one wrap-up step without tools asks the model for a
    summary of what is done and what is left (`loop.wrapUp`, default `true`; the stop stays
    `'max-steps'`). New fixed text `MAX_STEPS_WRAP_UP`.
  - **New:** progress guard (`loop.progress`): the same tool call with the same result 3 times in the
    last 20 tool steps, or 5 steps whose tool calls all failed, gets one reminder (`PROGRESS_NUDGE`,
    warning `W_LOOP_STUCK`) and then stops the turn with the new stop reason `'stuck'`.
    `loop.progress: false` disables it.
  - **New:** `turn.beforeEnd` continuations are bounded by progress: after `loop.maxIdleContinues`
    (default 3) continuations in a row without a new successful tool result, further continuations
    are refused (`W_CONTINUE_LIMIT` with `details.reason: 'no-progress'`). The hook event has a new
    `idleContinues` field.
  - `StopReason` gains `'stuck'` (exhaustive switches over `StopReason` need a new case).

- [#9](https://github.com/viandwi24/eharness/pull/9) [`2dcece5`](https://github.com/viandwi24/eharness/commit/2dcece5cd31bd5244dab2ddad8172a3455044c55) Thanks [@viandwi24](https://github.com/viandwi24)! - **New: `eharness/todos`** (spec 13, ADR-0018): the `todos()` plugin gives the model a
  `todo_write` checklist tool (whole-list replacement, one `in_progress` at a time, `cancelled`
  status), streams `data-todos.list` for UIs (`latestTodos(messages)`), reminds open todos with
  volatile step reminders (`remindEvery`, and once after a compaction) and, with `enforce: true`,
  keeps the turn going while todos are open — bounded by `maxNudges` and by progress.

## 0.2.0

### Minor Changes

- [#7](https://github.com/viandwi24/eharness/pull/7) [`e1e0d76`](https://github.com/viandwi24/eharness/commit/e1e0d76f2ed12d79e7f55422d515c38b7c15b37d) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** the minimum peer versions are now `ai@^7.0.123` and `@ai-sdk/mcp@^2.0.63` (the tested
  versions). eharness imports values such as `StreamProviderError` and `toolSearch` that early
  `ai` 7.0.x releases do not export; 0.1.0 already needed `ai` ≥ 7.0.104 in practice (first release exporting `toolSearch`).
  Migration: `npm install ai@^7.0.123` (and `@ai-sdk/mcp@^2.0.63` if you use `eharness/mcp`).
  
  **BREAKING (model-visible behaviour):** the built-in skill tools (`load_skill`, `read_skill_file`,
  `search_skills`) now validate their input with AI SDK. Malformed input (a missing or non-string
  field) is a tool error (`output-error` part, `step.end` status `'error'`) with AI SDK's text
  `AI_InvalidToolInputError: Invalid input for tool <tool>: …` instead of a result text
  ``ERROR: `<field>` must be a string``. Their JSON input schemas now include a `$schema` key
  (draft-07), which changes the tool definitions sent to the model once (one prompt-cache miss).
  Migration: if you match the old `ERROR: … must be a string` text, match the tool error instead.
  
  **Behaviour change:** `StepEndEvent.toolResults` is now derived from AI SDK's `StepResult`: results
  are listed in call order, and a tool whose `toModelOutput` returns `error-text` now has status
  `'output'` (it was `'error'`). Migration: to inspect the model output, read `event.step` or
  `event.responseMessages`.
  
  - Context overflow recovery now also works after AI SDK retries: a "prompt too long" rejection
    wrapped in a `RetryError` (e.g. a 429 followed by a 400, or behind a gateway error's `cause`)
    and `StreamProviderError`s with status 400/413 are recognised.
  - `describeError` uses the same classification. A `RetryError` whose last attempt has no HTTP
    status (e.g. a network error) but an earlier attempt was a 429 / 5xx now reads `Rate limited: …`
    / `Provider unavailable: …` instead of `Unexpected error (see server logs)`.
  - New: the `step.end` event exposes AI SDK's `StepResult` of the step as `step`.
  - Tool errors for invalid tool input and unknown tools now reach the UI stream and stored
    messages with the same text the model got (`AI_InvalidToolInputError: …`,
    `AI_NoSuchToolError: …`) instead of `Unexpected error (see server logs)`.
  - `DataChunk` is now derived from AI SDK's `UIMessageChunk` (same shape).

## 0.1.0

### Minor Changes

- [`d3a8deb`](https://github.com/viandwi24/eharness/commit/d3a8debd80b94208bbcbd37ec6a41568de958487) Thanks [@viandwi24](https://github.com/viandwi24)! - **eharness 0.1.0 — first public release.** Build your own agent harness on AI SDK v7:
  
  - **Agent and plugins:** `defineHarnessAgent`, `definePlugin` with services, hooks
    (`input.submit`, `turn.*`, `step.*`, `tool.*`, `message.beforeSave`, `compaction.*`,
    `skill.load`), namespaced data parts and message kinds, boot validation with `EH_*` errors.
  - **Context:** static and dynamic instructions, tools (`defineToolSource`, deferred tools with tool
    search, output limits with `truncate` / `evict`) and skills (`defineSkill`,
    `defineSkillSource`, `load_skill` / `read_skill_file` / `search_skills`), prompt-cache-friendly
    layout with turn/step reminders.
  - **Messages and streaming:** everything is a `UIMessage` (`InferHarnessUIMessage` for
    `useChat`), UUIDv7 ids, projection to the model, one AI SDK UI message stream per turn,
    `attach()` resume and `events()`.
  - **Sessions and storage:** two-method `MessageAdapter`, `StateAdapter` with optional `setIf`,
    `SessionLock`, per-step persistence, crash recovery, idle eviction; memory adapters in
    `eharness/storage/memory`.
  - **Compaction:** summarize + keep tail + guard, stored as `eh.compaction` markers, overflow
    recovery.
  - **Interaction:** tool approvals (`approval.policy`, grants, `respond()`), client-side tools,
    `regenerate()` / `edit()`, steering and queueing (`ifBusy`), `inject()` with wake-ups, and
    `handleChatRequest()` for `useChat`.
  - **Extensions:** `eharness/filesystem` (+ `memoryFs()`), `eharness/mcp` (`mcpServer()`), and
    `eharness/testing` with `scriptedModel()` and conformance suites for message, state, file
    system, skill source and id generator adapters.
  
  Changes in this release on top of the 0.0.x previews:
  
  - `scriptedModel()` also answers `doGenerate` calls (e.g. the compaction summarizer) from the same
    script, so one scripted model can drive a conversation that compacts.
  - The exported `version` constant now always equals the package version.
  - Tool functions (`tools: { x: (ctx) => tool(…) }`) get `ctx.stream.data(name, data)` typed with
    their owner's data parts: the plugin's `dataParts` for tools a plugin contributes (setup or
    session phase), the app's `dataParts` for top-level tools. `ToolInput` / `ToolsInput` and
    `HarnessAgentConfig` take the data part map as an optional type parameter (defaults keep
    existing code compiling).
  
  Stability: 0.x — breaking changes ship only in minor versions with a migration note. No public API
  is `experimental_`. Requires `ai@^7`, `zod@^3.25.76 || ^4.1.8`, Node ≥ 22 or Bun; `@ai-sdk/mcp@^2`
  is an optional peer for `eharness/mcp`.

### Patch Changes

- [`51fe06a`](https://github.com/viandwi24/eharness/commit/51fe06a1db092048c1791b00b307b5e109b97118) Thanks [@viandwi24](https://github.com/viandwi24)! - Context loading and compaction: the fixed compaction algorithm (pre-turn, mid-turn with
  `partial`, and manual `session.compact()`), rolling chunked summarization with a continuation-brief
  prompt and the `compaction.prompt` / `compaction.after` hooks, `eh.compaction` markers with a
  compaction pointer so cold loads need one `load({ fromId })` query (self-healing after lost state
  writes), calibrated token accounting (`metadata.eharness.tokens`, `session.stats()`,
  `data-eh.context` with `lastCompaction`), the complete guard (drop oldest turns, truncate the
  largest tool outputs in the request, `W_CONTEXT_TRUNCATED`, `EH_CONTEXT_OVERFLOW`), the `select`
  escape hatch, `compaction: false`, and provider overflow recovery (held-back error chunk,
  recalibration, compact-and-retry, tighter guard, `W_OVERFLOW_RETRY`, `config.isContextOverflow`).

- [`d49e337`](https://github.com/viandwi24/eharness/commit/d49e33732c38a4d404604e4ea90e4ecc7be1446f) Thanks [@viandwi24](https://github.com/viandwi24)! - Core foundations: `HarnessError` with stable `EH_*` codes, `isHarnessError`, `HarnessToolError`
  and warning codes; monotonic UUIDv7 ids (`uuidv7`, `isUuidV7`); the message model
  (`HarnessUIMessage`, `metadata.eharness`, `InferHarnessUIMessage`, stop reasons, turn results) and
  fixed model-visible texts; `defineDataPart`, `defineMessageKind`, `createKindMessage`,
  `isKindMessage` and the core `eh.*` data parts and kinds; `definePlugin` with typed hooks,
  services and a namespaced stream writer; `defineToolSource`; and `defineHarnessAgent` with the
  root plugin, synchronous setup phase and boot validation (duplicate tools/skills/data parts,
  service conflicts, missing services, plugin order, invalid names and options). `agent.session()`
  is not implemented yet. `eharness/testing` adds `idGeneratorConformance`.

- [`71bf127`](https://github.com/viandwi24/eharness/commit/71bf1279de34ee936b42fc5eca3b67fcfc7bf4bf) Thanks [@viandwi24](https://github.com/viandwi24)! - Filesystem plugin (`eharness/filesystem`, `eharness/filesystem/memory`): the `FileSystem` adapter
  contract with `normalizePath` and `contentVersion`, the in-memory `memoryFs()` adapter, and the
  `filesystem()` plugin providing the typed `fs` and `toolOutputs` services, the file tools
  `list_files`, `read_file` (line-numbered windows with `offset`/`limit`), `write_file`, `edit_file`
  (smart replace: exact, line-trimmed, whitespace-normalized; ambiguity rejected), `delete_file` and
  `grep`, with read-before-edit, `STALE:` results carrying the current content, optimistic locking
  (`CONFLICT:`), read-only/hidden prefixes, allowed extensions and undeletable files
  (`REJECTED:`), `lastRead` in plugin state, the `data-filesystem.change` part, a per-session `fs`
  resolver, and skills autoload through `fsSkillSource` (hidden skills root by default).
  `classifyToolResult` classifies tool results for UIs. `eharness/testing` adds
  `fileSystemConformance` for custom adapters. The `experimental_placeholder` exports of both
  filesystem entry points are removed.

- [`8790727`](https://github.com/viandwi24/eharness/commit/8790727ad9702a98699e1019d19b5b5ad7dc29e5) Thanks [@viandwi24](https://github.com/viandwi24)! - Interaction: `respond()` answers tool approvals and client tool calls against the server-owned
  pending state (all-or-nothing, `unknown-id` / `incomplete` / `stale` run errors, consumed in the
  commit-point state write so replays never execute anything) and continues the same assistant
  message; session approval grants (`remember: 'session'`, `clearGrants()`, `W_GRANT_IGNORED`) and a
  fail-closed approval policy; `approval.onNewInput` (`deny` / `reject` → `EH_PENDING_RESPONSE`);
  `regenerate()` and `edit()` with `eh.rewind` markers (hidden messages excluded from projection,
  compaction and `messages()`, `not-found` / `beyond-compaction`); `send(…, { ifBusy: 'steer' })`
  delivered as `data-eh.input` at the next step boundary and `ifBusy: 'queue'`; `inject()` with
  `deliver: 'next-step'` (`deliveredIn`) and `wake` (never lost; queued turns wait while approvals
  are pending); the `useChat` adapter `handleChatRequest()`.
  Client tool outputs pass through `tool.after` and output limits. Run errors carry
  `error.details` in `run.result`. Fixes automatically approved tools being executed twice.
  `EH_NOT_IMPLEMENTED` is removed from the error codes.

- [`ef5d8b9`](https://github.com/viandwi24/eharness/commit/ef5d8b991048c45f4f085819d0537aa37a282976) Thanks [@viandwi24](https://github.com/viandwi24)! - Sessions and the turn runtime: `agent.session(id)` now returns a live session (cached, idle
  eviction, `closeSession()` / `close()`). `send()` runs a multi-step turn (one `streamText` call per
  step) and returns a `HarnessRun` whose `stream` is the AI SDK UI message stream (`toResponse()`,
  `pipeTo()`, `attach()` to replay and follow a running turn); `run.result` never rejects. Turns
  persist the user message and the assistant message after every step through a `MessageAdapter`,
  keep namespaced plugin state through a `StateAdapter`, follow the normative lifecycle (lock,
  commit point, `input.submit`, `turn.prepare`, `step.prepare`, `step.end`, `turn.beforeEnd`,
  `tool.before` / `tool.after` / `tool.approve`, `message.beforeSave`), stop by the documented stop
  rules (`complete`, `tool-pending`, `max-steps`, `cost-cap`, `timeout`, `aborted`, `blocked`, …),
  answer interrupted tool calls, recover turns of crashed processes, and lay out prompts for caching
  (two stable system blocks, turn/step reminders, stable tool order, Anthropic `cacheControl`).
  Also: `session.inject()` (next-turn delivery), `messages()`, `stats()`, `events()`, `abort()`,
  `clearGrants()`. New entry points: `memoryMessages()` / `memoryState()` in
  `eharness/storage/memory`, and `messageAdapterConformance()`, `stateAdapterConformance()` and
  `scriptedModel()` in `eharness/testing`. Fix: `eh.event` payloads without `data` are valid.
  Not yet available (coming before 0.1.0): `respond()`, `regenerate()`, `edit()`, `compact()`,
  `ifBusy: 'queue' | 'steer'` and `inject()` with `deliver: 'next-step'` / `wake`.

- [`5aaf85c`](https://github.com/viandwi24/eharness/commit/5aaf85c3fcef2e0a1aaac765b951ead812f1e638) Thanks [@viandwi24](https://github.com/viandwi24)! - Skills: `defineSkill` and `defineSkillSource` with validation, static skills served through an
  in-memory source, skill-relative addressing with `validateSkillPath`, and `parseSkillMarkdown`
  (a dependency-free YAML subset for `SKILL.md` frontmatter, including `|`/`>` block scalars). The
  per-turn skill registry lists sources in plugin order with `refresh` caching, static skills winning
  over dynamic ones and first-wins shadowing between sources (`W_SHADOWED`), invalid
  metadata skipped (`W_INVALID_SKILL`) and failed listings retried next turn (new warning
  `W_SKILL_SOURCE_FAILED`). The model sees a sorted skills index in the system prompt (static skills
  in block 1, dynamic ones in block 2) or, above `skillsIndexLimit`, a search hint. The skill tools
  are stable for the whole session (`load_skill`/`read_skill_file` whenever a skill source exists,
  `search_skills` when search mode is reachable); they return errors as `ERROR:` strings and never
  pass an invalid path to a source. The `skill.load` hook event now carries `location` from
  `SkillSource.locate()`, and plugins can emit warnings with the new `ctx.warn()`.
  `eharness/testing` adds `skillSourceConformance` and `SKILL_SOURCE_FIXTURE`.

- [`0b6cc9c`](https://github.com/viandwi24/eharness/commit/0b6cc9c958e045038b5518efe15959f63b54487e) Thanks [@viandwi24](https://github.com/viandwi24)! - Tool sources and MCP: `defineToolSource({ defer: true })` marks a source's tools deferred and the
  core adds AI SDK's `toolSearch()` as `tool_search` whenever a deferred tool exists (discovered tools
  stay callable for the rest of the turn and after reloads); `defineToolSource` validates `refresh`,
  `defer`, `open` and `close`. Tool output limits (`toolOutput: { maxChars, perTool, strategy }`,
  default 50,000 characters): final outputs are truncated head + tail around
  `TOOL_OUTPUT_TRUNCATED` (structured outputs become `{ truncated, preview, originalChars }`), or
  evicted to the filesystem plugin's `toolOutputs` service with a `read_file` hint, with
  `W_TOOL_OUTPUT_LIMITED`. New `eharness/mcp` entry: `mcpServer()` turns an MCP server into a tool
  source over the optional peer `@ai-sdk/mcp` (loaded lazily) with one client per session, lazy or
  eager connect, allow/deny, prefixing, `defer: 'auto'`, `maxRetries`, reconnects after failures
  (`W_TOOL_SOURCE_FAILED`), definition pinning with drift exclusion (`W_MCP_DRIFT`) and
  `clearMcpPins()`.
  `eharness/mcp` no longer exports the `experimental_placeholder` constant (it was a placeholder with
  no behaviour). `read_file` now keeps its continuation hint inside `maxReadChars`, so a full window
  fits the default tool output limit.
  A failed session open now aborts the session's `ctx.signal` before that attempt's disposers run
  (a retried open gets a fresh signal), so plugins and tool sources release per-session resources.

## 0.0.2

### Patch Changes

- [#1](https://github.com/viandwi24/eharness/pull/1) [`55c3525`](https://github.com/viandwi24/eharness/commit/55c3525a546bd5c2e1d39be3fa802fd80f45c9ce) Thanks [@viandwi24](https://github.com/viandwi24)! - update docs
