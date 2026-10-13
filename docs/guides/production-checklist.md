# Production checklist

One page to review before you ship a harness. Each line says what to check and where to read why.
The walkthroughs show every item wired in real code: [server](walkthrough-server.md) (`examples/team`)
and [CLI](walkthrough-cli.md) (`examples/coder`). Items marked *(server)* matter once more than one
process, user or restart is involved.

## Correctness

- [ ] Storage adapters pass the conformance suites (`messageAdapterConformance`, `stateAdapterConformance`, lock, inbox, stream log, activity store). [Storage adapters](writing-a-storage-adapter.md), [testing](testing.md), [server §2](walkthrough-server.md#2-storage-messages-and-state)
- [ ] The message adapter upserts by id (`persistEachStep` saves the same message repeatedly) and message ids sort by creation time (UUIDv7). [Spec 05](../specs/05-session-and-storage.md), [spec 03](../specs/03-messages.md)
- [ ] Nothing of your own writes to storage before a turn's commit point; failures before it leave storage untouched. [Spec 05 §3](../specs/05-session-and-storage.md)
- [ ] Tools return expected failures as strings and never throw; only programmer errors throw. [Writing a plugin](writing-a-plugin.md), [CLAUDE.md rule 6](../../CLAUDE.md)
- [ ] Approvals are answered through `respond()` (or the attention route), never by posting the assistant message back; the pending set is consumed atomically. [ADR-0012](../decisions/0012-approvals-server-owned-pending.md), [approvals](approvals-and-interaction.md)
- [ ] Every client tool and question is answered or fails with an error string; none leaves a turn `tool-pending` forever. [CLI §5](walkthrough-cli.md#5-ask), [ask](ask.md)
- [ ] No dropped tool call: calls without a result are answered `Interrupted:`, never re-executed. [ADR-0014](../decisions/0014-interrupted-tool-calls-answered.md)
- [ ] Partial approval answers work in your UI (one step can raise several approvals). [ADR-0044](../decisions/0044-partial-resolution-of-pending-approvals.md)
- [ ] Static instructions and tools come first and keep a stable order; dates, rosters and other volatile text go in the turn reminder. [Server §1](walkthrough-server.md#1-the-agent-definition-and-where-the-model-comes-from), [spec 02](../specs/02-context-registry.md), [ADR-0013](../decisions/0013-cache-friendly-prompt-layout.md)
- [ ] `contextWindow` is known (catalog or explicit) so compaction can trigger; a long chat is tested past it. [Compaction](compaction.md), [server §11](walkthrough-server.md#11-compaction-and-tool-output)
- [ ] An explicit `maxOutputTokens` is set; some gateways reserve the model maximum per call otherwise. [Server §1](walkthrough-server.md#1-the-agent-definition-and-where-the-model-comes-from)
- [ ] Subagent and delegation limits are set (`maxDepth`, `maxConcurrent`, child steps, park and background timeouts). [Subagents](subagents.md), [server §7](walkthrough-server.md#7-background-children-and-reconcile)

## Restarts and multiple instances

- [ ] *(server)* A stable `recovery.instanceId`, unique among live instances of one storage. Without it a restarted process answers `EH_SESSION_BUSY` for ~120 s. [ADR-0056](../decisions/0056-restart-recovery-and-background-reconcile.md), [server §6](walkthrough-server.md#6-recovery-surviving-sigkill)
- [ ] *(server)* The lock lets a restarted instance take over its own previous leases (same owner prefix). [Server §3, §6](walkthrough-server.md#3-the-shared-lock)
- [ ] *(server)* `session.recover()` runs at boot for sessions that can hold a turn, not only at the next user message. [Server §6](walkthrough-server.md#6-recovery-surviving-sigkill)
- [ ] *(server)* A reconcile pass (boot and periodic) repairs parked waits and background children; it is safe on every instance at once. [Server §7](walkthrough-server.md#7-background-children-and-reconcile), [ADR-0056](../decisions/0056-restart-recovery-and-background-reconcile.md)
- [ ] *(server)* Wakes held while something waits for an answer are durable (inbox configured). [ADR-0054](../decisions/0054-held-wakes-while-pending.md)
- [ ] *(server)* The inbox has dead-letter handling and an alert; routines and retried webhooks use caller ids so a crash never fires twice. [Multi-instance](multi-instance.md#poison-items), [ADR-0040](../decisions/0040-enqueue-timers-and-ids.md)
- [ ] *(server)* Several instances share one lock, state, inbox, stream log, activity store and budget ledger; test with real processes and a `SIGKILL`. [Server §17](walkthrough-server.md#17-verify-it-like-the-example-does), [multi-instance](multi-instance.md)
- [ ] CLI: one stable instance id per project with a pid file so two live CLIs never share it. [CLI §12](walkthrough-cli.md#12-crash-recovery-and-retry)
- [ ] Schema and data changes are migrations, not adapter side effects; adapters never create tables at runtime. [Server intro](walkthrough-server.md)

## Streaming and transport

- [ ] A stream log is configured so a reload can land on any instance and resume; continuations replay in full. [ADR-0039](../decisions/0039-resumable-streams-stream-log.md), [ADR-0045](../decisions/0045-resume-replay-of-continuations.md), [server §4](walkthrough-server.md#4-the-stream-log)
- [ ] Idle timeouts of every hop (Bun `idleTimeout: 0`, load balancer, proxy) exceed your longest silent tool call. [Server §16](walkthrough-server.md#16-bunserve-and-idletimeout-0), [HTTP server](http-server.md#mounting)
- [ ] The activity feed keep-alive is below the shortest idle timeout of any hop (default 8 s; Bun's is 10 s). [Server §13](walkthrough-server.md#13-the-activity-feed), [spec 25](../specs/25-activity.md)
- [ ] Node adapters stream request and response bodies, forward `close` as an abort and do not buffer or compress `text/event-stream`. [HTTP server](http-server.md#mounting)
- [ ] Feed retention prunes a prefix, keeps the newest event and anything the UI previews; clients resync when their cursor is pruned or the boot id changes. [Server §13](walkthrough-server.md#13-the-activity-feed), [ADR-0058](../decisions/0058-activity-feed-and-attention-queue.md)
- [ ] The web client treats the feed as hints and refetches state on resync, focus, `online` and visibility changes. [Server §15](walkthrough-server.md#15-eharnessclient-in-the-svelte-web), [web client](web-client.md)
- [ ] Library logs and warnings never go to a terminal UI (`onWarning` to a file). [CLI §13](walkthrough-cli.md#13-rendering-with-ink)
- [ ] Custom data and kind messages are rendered (compaction, notices, todos, steered input). [Rendering data parts](rendering-data-parts.md)

## Security

- [ ] `authorize` is real (not `openAccess`) and runs before the body is read; denial is a return value, and a non-object result (`undefined`, `null`) is a 401 (fail closed). [Server §14](walkthrough-server.md#14-eharnesshttp), [spec 26](../specs/26-http.md)
- [ ] Never trust client messages: only the last user message with `text`/`file` parts is read; `actor`, `runtime`, `model`, `maxSteps` and `metadata` come from the server. [Production patterns: security](production-patterns.md#session-ownership), [spec 05 §3](../specs/05-session-and-storage.md)
- [ ] Sessions are owned: a user can read, chat with and answer only the sessions the server maps to them (`roots`, `canAnswer`, `resolve`). [Server §14](walkthrough-server.md#14-eharnesshttp)
- [ ] Attachments are validated (type allowlist, size, `library:` references) and the body size is limited. [Server §14](walkthrough-server.md#14-eharnesshttp), [client tools](client-tools.md)
- [ ] Permission rules, modes and protected paths are configured; write and destructive tools of third-party connectors ask even in Bypass. [Permissions](permissions.md), [server §8](walkthrough-server.md#8-permissions-and-approvals)
- [ ] A person's approval is never re-judged by an Auto-mode classifier (a classifier outage must not deny what a person approved). [ADR-0055](../decisions/0055-approval-answer-wins-and-schema-valid-denials.md), [guard](guard.md)
- [ ] Filesystem and shell are contained (virtual paths, roots, sandbox, output caps); repo-provided skills, agents and commands load only for trusted projects. [Filesystem](filesystem.md), [shell](shell.md), [CLI §3, §9](walkthrough-cli.md#3-workspace-filesystem-and-the-shell)
- [ ] `web_fetch` guards against SSRF: pass `resolveHost: nodeResolveHost` (`eharness/web/node`) or `onlyAllowed` (without either you get `W_WEB_NO_RESOLVER`); a pinned-IP `fetch` closes the DNS rebinding gap; URLs fetched by the provider are allowlisted. [Web](web.md), [production patterns](production-patterns.md#urls-fetched-by-the-provider)
- [ ] `eharness/http` accepts only `data:` URLs in client file parts; turn on `chat.allowFileUrls` (http/https or a predicate) only with an allowlist. [HTTP server](http-server.md), [production patterns](production-patterns.md#urls-fetched-by-the-provider)
- [ ] Connector OAuth refuses private, loopback and link-local hosts and cross-origin redirects; set `oauth: { allowPrivateNetwork: true }` only for local development, and bind flows to a `principal` so a callback cannot be completed by another user. [Connectors](connectors.md)
- [ ] The permissions engine gets `realpath: nodeRealpath` (`eharness/filesystem/node`) so protected paths and Read/Edit rules match the symlink-resolved path; a recursive `grep -r`/`rg` of a directory that holds `.env` files asks only with `containsProtected: nodeContainsProtected` next to it (otherwise recursive reads are lexical); session grants never cover high-risk flags. [Permissions](permissions.md), [filesystem](filesystem.md)
- [ ] Code execution (`eharness/code`) runs in a container or microVM driver for agent-written code; a local sandbox has the OS sandbox on with `denyReadHome`/`denyRead` and `limits`; `requireIsolation: true`; `packages.install` is `'off'` or an allowlist with the stored list in `readonlyPrefixes`; scripts have no network. [Code sandbox](code-sandbox.md)
- [ ] Shell commands inherit only the env allow-list (`PATH`, `HOME`, `LANG`, ...); add what a project needs through `env`, and use `inheritEnv: true` only on a machine with no secrets in `process.env`. [Shell](shell.md)
- [ ] Remote MCP servers keep `pinDefinitions` on (the default) and `wrapUntrusted` on; OpenAPI responses stay framed as untrusted content. [Tools and MCP](tools-and-mcp.md), [OpenAPI tools](openapi-tools.md)
- [ ] Secrets (provider keys, connector tokens) are sealed at rest and never logged; error texts to clients are generic for 5xx. [Providers](providers-and-profiles.md), [production patterns](production-patterns.md#logs-and-error-texts)
- [ ] Model-call logs hold raw prompts: apply retention and access control. [Debugging and activity logs](debugging-and-activity-logs.md)

## Timeouts and bounds

Nothing the core awaits can hang a turn forever; check the defaults fit your slowest legitimate work.

- [ ] `hooks.timeoutMs` (default 30 000) fits your slowest hook; a timed-out hook warns (`W_HOOK_TIMEOUT`), `input.submit` and `tool.approve` stay fail-closed. [Spec 01](../specs/01-agent-and-plugins.md)
- [ ] The model idle timeout (`settings.timeout`: `firstChunkMs` / `chunkMs`, default 120 000 each; `false` turns it off) is longer than your slowest reasoning model's silence, and `maxRetries` (default 2) is what you want. [Models and cost](models-and-cost.md)
- [ ] MCP connect and tool listing have `timeoutMs` (default 15 000, `EH_MCP_TIMEOUT`); `toolSources.timeoutMs` and `toolSources.retryAfterMs` bound listing and the backoff of a failing source. [Tools and MCP](tools-and-mcp.md)
- [ ] OAuth requests (discovery, registration, token, refresh) have the default 15 000 ms limit and a 1 MiB response cap. [Connectors](connectors.md)
- [ ] Background subagents have `background.timeoutMs` (default one hour) with `stopOnTimeout`; `diskFs` ripgrep has `grepTimeoutMs` / `grepMaxOutputBytes`. [Subagents](subagents.md), [filesystem](filesystem.md)
- [ ] Every numeric option is bounds-checked at boot (`EH_CONFIG_INVALID`; durations above one day are rejected), so a typo fails the deploy, not the first turn.

## Cost and limits

- [ ] Prices and windows come from a catalog; unpriced models are known and warned about (`W_MODEL_UNPRICED`). [Models and cost](models-and-cost.md)
- [ ] A budget is set and, with several instances or sessions, it is a shared ledger, not per-process memory. [Budgets across sessions](models-and-cost.md#budgets-across-sessions), [server §12](walkthrough-server.md#12-cost-and-limits)
- [ ] Turns are bounded: `loop.maxSteps`, progress guard, optional output-token and time caps; unattended runs have a budget. [Long-running turns](long-running-turns.md)
- [ ] `toolOutput` limits tool results (`evict` for big outputs) and old tool output is pruned before summarizing. [Compaction](compaction.md#pruning-old-tool-outputs)
- [ ] MCP and rarely used tools are deferred behind `tool_search`. [Tools and MCP](tools-and-mcp.md), [CLI §10](walkthrough-cli.md#10-mcp)
- [ ] Multi-agent features have caps on concurrency, depth and total children; they multiply cost. [Lead and role agents](lead-and-role-agents.md)
- [ ] Event, stream-log, inbox and model-call tables have retention. [Server §13](walkthrough-server.md#13-the-activity-feed)

## Observability

- [ ] A `model.call` log (raw request and response, tokens, cost, latency) with retention. [Debugging and activity logs](debugging-and-activity-logs.md), [ADR-0047](../decisions/0047-model-call-observer.md)
- [ ] `onWarning` is wired to your logger; `W_*` codes are alerts or metrics, not console noise (the default handler dedupes per code and key within `warnings.dedupeWindowMs`). [Spec 10](../specs/10-errors-and-stop-reasons.md)
- [ ] `observe` feeds your metrics: phase durations (`lock.wait`, `model.call`, `tool.execute`, ...) and the counters `hook.failed`, `hook.timeout`, `events.overflow`, `state.conflict`, `tool-source.backoff`. [Observability](observability.md)
- [ ] `W_INVARIANT_VIOLATION` is an alert in production and a failing test in CI (`debug: { invariants: true }` in your test setup; it is never switched on from `NODE_ENV`). [Testing](testing.md)
- [ ] `EH_LOCK_UNAVAILABLE` (a failing lock service, HTTP 503) and `EH_PROVIDER_AUTH` (bad or missing provider key) are monitored separately from `EH_SESSION_BUSY`. [Spec 10](../specs/10-errors-and-stop-reasons.md)
- [ ] Stop reasons are recorded and alerted on (`error`, `stuck`, `max-steps`, `cost-cap`, `timeout`, `interrupted`). [Long-running turns](long-running-turns.md), [spec 10](../specs/10-errors-and-stop-reasons.md)
- [ ] Audit permission decisions and approval answers (who, what, when). [Approvals](approvals-and-interaction.md), CLI [`permissions/audit.ts`](../../examples/coder/src/permissions/audit.ts)
- [ ] Inbox dead letters, reconcile reports and recovered turns are logged; `onFailure` reports 5xx errors server side. [Server §6, §14](walkthrough-server.md#6-recovery-surviving-sigkill)
- [ ] A health route exists and the web client pings it while work runs so a killed server is noticed at once. [Server §15](walkthrough-server.md#15-eharnessclient-in-the-svelte-web)
