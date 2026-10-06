# eharness

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
