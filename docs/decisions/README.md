# Architecture Decision Records

New ADR: copy the shape of an existing one, next number, status `Proposed` until merged.
Superseding an ADR: mark the old one `Superseded by ADR-xxxx`; never delete.

| ADR | Title |
|---|---|
| [0001](0001-build-on-ai-sdk-primitives.md) | Build on AI SDK primitives, no parallel types |
| [0002](0002-manual-step-loop.md) | Manual step loop (one streamText per step) |
| [0003](0003-uimessage-storage-form.md) | UIMessage is the storage form |
| [0004](0004-fixed-compaction-pluggable-storage.md) | Compaction is fixed; storage is the extension point |
| [0005](0005-compaction-marker-as-message.md) | Compaction markers are ordinary kind messages |
| [0006](0006-skill-relative-addressing.md) | Skill files are addressed relative to the skill |
| [0007](0007-single-package-subpaths.md) | One package with subpath exports |
| [0008](0008-plugins-adapters-dogfooding.md) | Plugins bundle capabilities; adapters implement contracts; shipped plugins use only public API |
| [0009](0009-release-changesets-trusted-publishing.md) | Release with Changesets and npm trusted publishing |
| [0010](0010-bun-dev-node-runtime.md) | Bun for development, runtime-neutral library |
| [0011](0011-stored-order-equals-model-order.md) | Stored order equals model order (inline input parts) |
| [0012](0012-approvals-server-owned-pending.md) | Tool approvals via AI SDK `toolApproval` with server-owned pending state |
| [0013](0013-cache-friendly-prompt-layout.md) | Cache-friendly prompt layout with reminders |
| [0014](0014-interrupted-tool-calls-answered.md) | Interrupted tool calls are answered, not dropped |
| [0015](0015-progress-bounded-loop.md) | Long turns are bounded by progress, not by small counts |
| [0016](0016-model-catalog-and-budgets.md) | Model limits and prices come from an app-supplied catalog |
| [0017](0017-tool-risk-and-approval-decisions.md) | Tool risk in AI SDK metadata; approval decisions are observable |
| [0018](0018-todos-in-history.md) | Todos live in the conversation, reminders are volatile |
| [0019](0019-prune-stage-and-thrash-stop.md) | Prune stage and thrash stop (amends 0004) |
| [0020](0020-pre-compaction-flush.md) | Pre-compaction flush: internal call, audit record, auto-denied approvals (amends 0004) |
| [0021](0021-cross-process-abort.md) | Cross-process abort through state compare-and-set |
| [0022](0022-memory-on-filesystem.md) | Memory on FileSystem; provider memory tools are app-supplied |
| [0023](0023-structured-final-output.md) | Structured final output per turn (tool and native modes) |
| [0024](0024-durable-inbox-port.md) | Durable inbox port: at-least-once with dedupe, drained by the session holder |
| [0025](0025-external-risk-and-mcp-annotations.md) | External risk and tighten-only MCP annotation mapping (amends 0017) |
| [0026](0026-inbox-retries-and-dead-letter.md) | Inbox retries and dead-letter: attempts at claim, uncounted deferrals, opt-in limits (amends 0024) |
| [0027](0027-external-waits-park-at-the-tool-boundary.md) | External waits: park at the tool boundary, record with a compare-and-set, timeouts via inbox timers (amends 0012, 0014) |
| [0028](0028-request-scoped-client-tools-and-page-context.md) | Request-scoped client tools and page context: opt-in, validated, no implied permission, data in the turn reminder (amends 0013) |
| [0029](0029-cross-session-budget-ledger.md) | Cross-session budget ledger port: reserve / commit, fail closed (amends 0016) |
| [0030](0030-llm-approval-guard-plugin.md) | LLM approval guard as a plugin: tighten-only, restricted view in core, cached verdicts |
| [0031](0031-group-chat-helper-outside-the-turn.md) | Group chat: gate in a helper outside the turn, merged bounded history, anti-loop derived from storage |
| [0032](0032-openapi-tools-outbound-http.md) | OpenAPI tools: outbound HTTP, app-supplied base URL and auth, no remote refs |
| [0033](0033-wrap-plugin.md) | `wrapPlugin`: composing plugins through the public API (setup / session / hook interception with `next`) |
| [0034](0034-deployment-profiles.md) | Deployment profiles: autonomous, single-process interactive and split web/server are all first-class |
| [0035](0035-nested-approvals-park-the-parent.md) | Nested approvals: park the parent at the tool boundary (`inline` / `park` / `deny`) |
| [0036](0036-node-only-modules.md) | Node-only modules: `eharness/filesystem/node` and `eharness/shell`, enforced by `check-imports` |
| [0037](0037-fork-and-child-index.md) | Fork keeps ids; the child index is a foreign-writable field of the parent's state |
| [0038](0038-agent-messaging.md) | Agent messaging: `send_message`, named agents, resume of finished children |
| [0039](0039-resumable-streams-stream-log.md) | Resumable streams via a stream log port (`storage.streams`, `attachRemote`, `handleResumeRequest`) |
| [0040](0040-enqueue-timers-and-ids.md) | `enqueue()` timers and caller ids: routines on the inbox, no scheduler port |
| [0041](0041-park-mode-messaging.md) | Agent messaging in `park` mode: storage-backed directory, delivery over the durable inbox (supersedes the park limit of 0038) |
| [0042](0042-peek-child-identity-spawn-cap.md) | Read-only `agent.peek`, child identity in the child index, `childSession` options and `maxChildren` |
| [0043](0043-enqueue-source-metadata-fs-versions.md) | Caller id on the turn, `enqueue` app metadata, optional `FileSystem` versions |
| [0044](0044-partial-resolution-of-pending-approvals.md) | Partial resolution of pending approvals: `respond()` records a subset, the last answer continues |
| [0048](0048-providers-module.md) | `eharness/providers`: definitions, profiles, a manager and a cached catalog loader (module fetches via injected `fetch`) |
| [0047](0047-model-call-observer.md) | Model call observer: the `model.call` hook, an AI SDK middleware, `observeModel` |
| [0046](0046-durable-background-subagents-in-park-mode.md) | Durable background subagents in `park` mode: durable start through the child inbox, report events through storage, run marker for every park call |
| [0049](0049-connectors-module.md) | `eharness/connectors`: definitions, connections, enablement, activation; reuses the providers' config layer |
| [0050](0050-flow-view-vocabulary.md) | Setup flows are server-driven views from a closed vocabulary (stale-view guard, sealed scratch) |
| [0051](0051-precedence-and-pinned-ask.md) | Mode precedence, most-restrictive combination and pinned asks under bypass |
| [0052](0052-generic-secret-vault.md) | One generic `SecretVault` and `sealedProfileStore` for providers and connectors |
| [0053](0053-providers-connectors-consolidation.md) | One sealing format, `toolPrefix`, per-flow `clientConfig`; providers and connectors share building blocks but stay separate areas |
| [0054](0054-held-wakes-while-pending.md) | Wakes held while items wait for an answer are durable inbox `wake` items (survive restarts, run in whichever instance resolves the pending items) |
| [0055](0055-approval-answer-wins-and-schema-valid-denials.md) | A person's approval is never overruled by the classifier on re-validation; stored `output-denied` parts are always schema-valid (repaired, not dropped, on load); classifier outages are not blocks |
| [0057](0057-session-invariants-and-fuzz.md) | Session invariants enforced at save time (`debug.invariants`, repair-don't-drop), a seeded fuzz test and a multi-instance conformance suite |
| [0056](0056-restart-recovery-and-background-reconcile.md) | Stable `recovery.instanceId`, `session.recover()`, `inject({ key })` and `reconcileBackgroundChildren`: restarts recover at once and background children never leave the parent silent |
| [0059](0059-http-and-client-modules.md) | `eharness/http` (fetch-style routes behind one `authorize`) and `eharness/client` (browser/UI side over AI SDK `DefaultChatTransport`; lands in the same release) |
| [0058](0058-activity-feed-and-attention-queue.md) | `eharness/activity`: session activity feed (plugin, `ActivityStore`, SSE) and the attention queue (`listAttention`, `answerAttention`); new `message.saved` hook |
