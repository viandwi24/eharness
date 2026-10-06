# Spec 03 — Messages

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Module: `src/messages`.

This is the most important contract in eharness: it defines what is **stored**, what is
**streamed**, and what the **model sees**.

## 1. Principles

1. The stored and streamed shape is AI SDK's `UIMessage` — no parallel message type (ADR-0003).
2. Custom content is expressed only with AI SDK mechanisms that already exist:
   - **metadata** (`message.metadata`) for message-level facts,
   - **data parts** (`{ type: 'data-<name>', id?, data }`) for typed custom content,
   - **message kinds** = a `UIMessage` whose single part is a data part, marked in metadata.
3. The model never sees stored messages directly. It sees a **projection** (§6) that every custom
   part and kind declares explicitly (default: omitted).
4. Everything stored is JSON and validated on load against the registry.

## 2. The message type

```ts
import type { UIMessage, InferUITools, ToolSet } from 'ai'

export type HarnessUIMessage<
  AppMeta extends Record<string, unknown> = {},
  Data extends Record<string, unknown> = HarnessDataTypes,
  Tools extends ToolSet = ToolSet,
> = UIMessage<HarnessMetadata & AppMeta, Data, InferUITools<Tools>>

/** Infer the exact message type of an agent (all plugin/app data parts, tools, kinds). */
export type InferHarnessUIMessage<A> = A extends { '~types': { message: infer M } } ? M : never
```

Frontends use it directly: `useChat<InferHarnessUIMessage<typeof agent>>()`.

`HarnessDataTypes` is the map of **core** data parts only (§4.3). The full map for a concrete
agent (core + namespaced plugin parts/kinds + app parts/kinds) is computed from its config type and
obtained with `InferHarnessUIMessage<typeof agent>`.

## 3. Metadata

`metadata.eharness` is reserved. Apps may add their own top-level metadata keys next to it.

```ts
export interface HarnessMetadata {
  eharness?: HarnessMessageMeta
}

export interface HarnessMessageMeta {
  /** Schema version of this object. */
  v: 1
  /** Epoch ms. */
  createdAt: number
  /** Present only on kind messages (§5). Absent = ordinary chat message. */
  kind?: string
  /** Turn that produced or received this message. */
  turnId?: string
  /** Cached token estimate of this message's model projection (spec 06 §2). */
  tokens?: number
  /** User messages: the id the client used, if any (ids are always server-generated, §8). */
  clientId?: string
  /** Id of the previous message on the active path (enables branching/fork later; set on every message the core creates). */
  parentId?: string | null
  /** User messages: number of trailing text parts added by input.submit `context` (UIs may hide them). */
  augmented?: number
  /** Kind messages delivered into a running turn (spec 11 §6.3): the assistant message that carries them. */
  deliveredIn?: string
  /** User messages made from one inbox item (`session.enqueue()`, spec 05 §12): its id (dedupe). */
  inboxId?: string
  /** User messages merged from `collect` inputs (spec 05 §12 rule 6): one entry per input, in
   *  arrival order (`inboxId` when it came through `enqueue()`, the client's id when it had one). */
  collected?: Array<{ inboxId?: string; clientId?: string }>

  // assistant messages only
  /** Gateway strings as-is ('anthropic/claude-sonnet-4.6'); provider instances as
   *  '<provider>/<modelId>' ('anthropic.messages/claude-sonnet-4-6'). The provider family used by
   *  projection (§6 step 5) is the part before the first '/', then before the first '.'. */
  model?: string
  /** Flattened from AI SDK LanguageModelUsage: reasoningTokens = outputTokenDetails.reasoningTokens,
   *  cachedInputTokens = inputTokenDetails.cacheReadTokens. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number
            cachedInputTokens?: number; cacheWriteTokens?: number; nested?: number; costUsd?: number }   // nested = addUsage() total; costUsd spec 12
  stop?: StopReason
  /** Set when the turn ended with stop 'tool-pending'; null once resolved (spec 11 §2). Metadata is
   *  deep-merged by AI SDK, so resolution writes null instead of deleting the key. 0.5.0: the copy
   *  carries `v: 2` and `externals` (spec 11 §4.2); the copy is not updated when a wait is
   *  recorded (`state.core.pending` is authoritative), only nulled at the continuation. */
  pending?: PendingState | null
  steps?: number
  durationMs?: number
  error?: { code?: string; message: string }
  /** 0.4.0: turns with SendOptions.output (spec 05 §3.3): a valid answer was recorded; answers checked. */
  output?: { ok: boolean; attempts: number }
}
```

Rules:

- `eharness.createdAt` and `eharness.v` are set by the core on every message it creates. For the
  assistant message they are sent in the `start` chunk, so per-step snapshots are already valid
  (spec 04 §2).
- Client-supplied `metadata.eharness` is **discarded** and rebuilt by the server (spec 05 §3).
  App metadata keys from the client are kept only if `SessionOptions.acceptClientMetadata` is true
  (default false). Convention: shipped plugins use one top-level app key named after the plugin
  (e.g. `metadata.group = { author, chatId?, messageId? }`, spec 16 §3).
- Unknown keys inside `metadata.eharness` must be preserved on load/save (forward compatibility).

## 4. Data parts

### 4.1 Definition

```ts
export function defineDataPart<S extends FlexibleSchema>(def: DataPartDef<S>): DataPartDef<S>

export interface DataPartDef<S extends FlexibleSchema = FlexibleSchema> {
  /** Schema of `data` (zod, Standard Schema, or jsonSchema()). Used for types and load validation. */
  schema: S
  /** Transient parts are streamed but never persisted or projected. Default false. */
  transient?: boolean
  /**
   * How a persisted part appears to the model. Default 'omit'.
   * 'text' → JSON.stringify(data) wrapped as <data type="…">…</data>.
   * function → return a TextPart/FilePart or undefined to omit.
   */
  model?: 'omit' | 'text' | ((data: InferSchema<S>, ctx: ProjectionContext) => TextPart | FilePart | undefined)
  /** Upgrade old stored data before validation (schema evolution). */
  upgrade?: (data: unknown) => unknown
}
```

### 4.2 Namespacing

| Owner | Declared as | Part type |
|---|---|---|
| core | built-in | `data-eh.<name>` |
| plugin `filesystem` | `dataParts: { change: … }` | `data-filesystem.change` |
| app (root) | `dataParts: { invoice: … }` | `data-invoice` |

- App names must match `^[a-z][a-zA-Z0-9-]*$` (no dot) and must not start with `eh`.
- Plugin keys follow the same rule; the core prefixes `<plugin>.`.
- Collisions are boot errors (`EH_DUPLICATE_DATA_PART`).

### 4.3 Core data parts

| Type | Transient | Data | Purpose |
|---|---|---|---|
| `data-eh.status` | yes | `{ state: 'thinking' \| 'tool' \| 'compacting' \| 'idle'; step?: number; tool?: string }` | live spinner |
| `data-eh.usage` | yes | `{ inputTokens; outputTokens; totalTokens; steps; costUsd? }` cumulative for the turn (cost: spec 12) | live cost |
| `data-eh.context` | yes | `ContextStats` (spec 06 §2, absolute token counts), written after each step | context meter |
| `data-eh.warning` | yes | `{ code: string; message: string }` | non-fatal problems (spec 10) |
| `data-eh.input` | **no** | `{ source: 'user' \| 'event' \| \`plugin:${string}\`; text: string; files?: FileUIPart[]; clientId?: string; inboxId?: string }` (`inboxId`: a steer from the durable inbox, spec 05 §12) | input delivered **inside** a running assistant message (steer, next-step events, hook context — spec 11 §6); projected by splitting the message (§6) |
| `data-eh.output` | **no** | `{ value: unknown; mode: 'tool' \| 'native'; attempts: number }` | the validated final answer of a turn with `SendOptions.output` (0.4.0, spec 05 §3.3); id `output` (reconciled), written once after the last step; `model: 'omit'` (never projected); `value` equals `TurnResult.output` |
| `data-eh.compaction` | — | kind payload (§5.3) | compaction marker (kind) |
| `data-eh.notice` | — | kind payload (§5.3) | error/abort/system notices (kind) |
| `data-eh.event` | — | kind payload (§5.3) | app-injected events (kind) |
| `data-eh.rewind` | — | kind payload (§5.3) | regenerate/edit/revert marker (kind) |
| `data-eh.flush` | — | kind payload (§5.3) | pre-compaction flush audit record (kind, 0.4.0); during a turn also written once as a **transient** chunk with the same payload when the flush ends (like `data-eh.compaction`) |

Final numbers (usage, model, stop) go to `metadata.eharness` of the assistant message, not to data
parts (AI SDK guidance: metadata for message-level facts).

### 4.4 Multiple data parts

A message may contain any number of data parts of any registered types, interleaved with text,
reasoning, tool and file parts. Parts with the same `type` **and** `id` are reconciled (last write
wins) by the AI SDK stream reader — the same reader we use to build the stored message (spec 04 §5),
so reconciliation behaves identically on client and server. A reconciled part keeps the **position of its first
write** and the data of its last write. To show a new version at the end of the message, write a
part with a new `id`.

## 5. Message kinds (custom messages)

A **message kind** is a message the model did not generate: a compaction marker, a notice, an
injected event, a subagent report, a scheduled reminder. It is still a normal `UIMessage`.

### 5.1 Definition

```ts
export function defineMessageKind<S extends FlexibleSchema>(def: MessageKindDef<S>): MessageKindDef<S>

export interface MessageKindDef<S extends FlexibleSchema = FlexibleSchema> {
  /** Role used when stored. 'assistant' or 'user'. */
  role: 'user' | 'assistant'
  schema: S
  /**
   * Projection to the model. Default 'omit'.
   * function → return text/parts for a single model message with `role`, or null to omit.
   */
  model?: 'omit' | ((data: InferSchema<S>, ctx: ProjectionContext) => string | Array<TextPart | FilePart> | null)
  /** A boundary starts the model context (only the newest boundary counts; spec 05 §5). Default false. */
  boundary?: boolean
  upgrade?: (data: unknown) => unknown
}
```

### 5.2 Stored shape (normative)

```jsonc
{
  "id": "0192f1c3-7c1e-7a3b-9f10-5d2b1c9e4a77",     // UUIDv7
  "role": "user",
  "metadata": { "eharness": { "v": 1, "createdAt": 1790000000000, "kind": "eh.compaction", "turnId": "…" } },
  "parts": [ { "type": "data-eh.compaction", "data": { /* payload */ } } ]
}
```

- Exactly **one** part, of type `data-<kind>`.
- `metadata.eharness.kind` equals the kind name. Both must agree; otherwise the message is invalid.
- A kind is automatically registered as a (persistent) data part with the same name, so UIs render
  it with the same component whether it arrives live (§5.4) or from history.

### 5.3 Core kinds

| Kind | Role | Boundary | Model projection | Payload |
|---|---|---|---|---|
| `eh.compaction` | user | **yes** | `<conversation-summary>{summary}</conversation-summary>` | `CompactionPayload` (spec 06 §3): `{ summary; resumeFromId; partial?; tokens; trigger; model? }` |
| `eh.notice` | assistant | no | omit | `{ level: 'info' \| 'warning' \| 'error'; code?: string; message: string }` — the core saves one for turns ending with `stop: 'error'`, `'timeout'`, `'blocked'` (with `persist`) and for recovered turns (`EH_TURN_INTERRUPTED`); aborts are recorded only in `metadata.eharness.stop` |
| `eh.event` | user | no | `<event name="{name}">{text}</event>` | `{ name: string; text: string; data?: unknown }` |
| `eh.rewind` | user | no | omit | `{ afterId: string \| null; reason: 'regenerate' \| 'edit' \| 'revert' }` — hides `afterId < id < rewind.id` (spec 11 §5) |
| `eh.flush` (0.4.0) | assistant | no | omit | `FlushPayload` (spec 06 §5.2a): `{ trigger: 'auto' \| 'manual' \| 'turn' \| 'overflow'; prompt; model?; steps; toolCalls: Array<{ toolName; status: 'output' \| 'error' \| 'denied' }>; usage: { inputTokens; outputTokens; totalTokens }; costUsd?; error? }` — audit record of a pre-compaction flush; no tool inputs/outputs; saved before the marker; `turnId` = the running turn (manual: none) |

### 5.4 Creating kind messages

```ts
await session.inject('eh.event', { name: 'backtest.finished', text: 'Backtest #42 finished: +12%' })
// → validated, saved immediately (UUIDv7 id, so it sorts after everything stored so far)
// → default delivery: enters the model context at the NEXT turn
await session.inject('eh.event', {...}, { deliver: 'next-step' })   // into the running turn (spec 11 §6.3)
await session.inject('eh.event', {...}, { wake: true })             // start a turn if idle
```

- `createKindMessage(kind, data, { role?, id?, createdAt?, turnId?, parentId?, deliveredIn?, partId? })`
  builds the normative shape (§5.2) without validating `data`; `role` defaults to the core kind's
  role for `eh.*` kinds and to `'user'` otherwise. `isKindMessage(message, kind?)` checks the shape.
- `session.inject(kind, data, opts?)` validates `data`, creates the message, saves it, and emits it
  on the session event channel (spec 04 §6). Delivery and wake-up options: spec 11 §6.3.
- Default (`next-turn`) keeps stored order equal to model order trivially. `next-step` delivery
  keeps it too, because the delivered content is also written as a `data-eh.input` part at the exact
  position inside the running assistant message (ADR-0011).
- The core itself creates `eh.compaction` (spec 06), `eh.notice` (errors, crash recovery) and
  `eh.rewind` (spec 11 §5).

## 6. Projection to the model

```
project(view: HarnessUIMessage[], ctx: { registry; tools; model; sessionId;   // sessionId → ProjectionContext
        pending: PendingState | null;        // spec 11 §2
        continuing?: string                  // id of the message a respond() continues
      }) → Promise<ModelMessage[]>
  input: the assembled view from the loader (spec 05 §5): [boundary?] + visible messages in id
         order — rewound (hidden) messages and superseded boundaries are already removed

  1. partial:    if the boundary has `partial`, drop the parts of `partial.messageId` before its
                 `partial.fromStep`-th `step-start` part (spec 06 §3)
  2. kinds:      kind messages with `metadata.eharness.deliveredIn` → drop (already delivered
                 inline); other kinds → def.model → one message with def.role, or drop
  3. interrupted tool calls: every tool part without a result — `input-streaming`,
                 `input-available`, `approval-requested` not in `ctx.pending`, and
                 `approval-responded` unless it belongs to `ctx.continuing` — is projected as
                 an error result with the text `INTERRUPTED_UNKNOWN` (spec 10 §5), never silently
                 dropped (ADR-0014). An `approval-responded` part outside the continued message
                 would otherwise become a `tool-approval-response` in a non-final position, which
                 AI SDK never executes and providers reject. The stored message is patched the
                 same way when a turn ends (spec 05 §3).
  4. split:      split each assistant message at every `data-eh.input` part:
                 assistant(parts before) → user(text + files) → assistant(parts after)
  5. foreign reasoning: for assistant messages whose metadata.eharness.model has a different
                 provider than ctx.model, drop reasoning parts and provider metadata
                 (signatures / item ids are provider-specific)
  6. convertToModelMessages(msgs, {
       tools,                          // turn tool set, for tool output conversion
       ignoreIncompleteToolCalls: true, // safety net; step 3 already answered them
       convertDataPart: part => registry.dataPart(part.type)?.model …   // 'omit' | 'text' | fn
     })
  7. sanitize: remove tool results without calls and empty messages (spec 06 §6)
```

**Prune (turn wire only, 0.4.0).** With `compaction.prune` on, the wire builder of a turn (spec 06
§6) applies the prune stage (spec 06 §5.0) to the projection of each completed turn except the
newest `keepTurns`, after step 7: large tool outputs become `{ type: 'text', value:
TOOL_OUTPUT_PRUNED }`. `project()` itself never prunes (token estimates and the summarizer
transcript use unpruned projections).

Details (normative for the implementation in `src/messages/project.ts`):

- Only the newest boundary (highest id) of the view is projected, and only its `partial` counts;
  older boundaries are dropped (the loader normally removes them already). If
  `partial.messageId` has fewer `step-start` parts than `fromStep + 1`, all its parts are dropped.
- Kind messages whose kind is not registered, or whose projection returns `null` / an empty
  result, are dropped. `role: 'system'` messages are never projected (spec 02 §5).
- Step 3 answers `approval-requested` parts unless they belong to `ctx.pending` (same message id
  and tool call id). A pending client tool call (`input-available`) is answered by `project()` like any
  other call without a result; the turn operations (P2/P7: `respond()`, `onNewInput: 'deny'`) must
  therefore patch pending client tool parts in the stored message before they project. A preliminary
  `output-available` part (`preliminary: true`) has no final result and is answered too. The
  answered part is `output-error` with `input` (or `{}` when the input never finished streaming)
  and without its `approval` object.
- Step 4: the user message built from a `data-eh.input` part has one text part (`text`) followed
  by its `files`. Consecutive inputs become consecutive user messages.
- Step 5 applies only when both the stored `metadata.eharness.model` and `ctx.model` have a
  provider family (§3) and they differ; it drops `reasoning` / `reasoning-file` parts and
  `providerMetadata` / `callProviderMetadata` / `resultProviderMetadata`.
- `'text'` data part projection uses the part name without the `data-` prefix:
  `<data type="filesystem.change">{…}</data>`. Transient and unregistered data parts are omitted.
- Step 7 synthesizes missing results into the tool message that follows the assistant message
  (or a new one) and matches results only against the calls of the directly preceding assistant
  message; orphan `tool-approval-response` parts are removed like orphan results.

- Transient data parts never exist in stored messages (AI SDK never adds them), so projection does
  not need to filter them; unknown data part types were removed in memory by validation (§7).
- A data part with a non-`omit` projection is inserted **where it sits** in the message (AI SDK
  behaviour), e.g. after a tool call.
- Projection is deterministic (no I/O besides AI SDK's async conversion) → golden tests.
- Round-trip requirement: for any assistant `UIMessage` built from a stream, `project()` must
  produce the same model messages the loop sent (JSON-equal, ignoring `undefined`-valued keys),
  **modulo** sanitize, guard truncation, reminders (spec 02 §5), and data parts / kinds with a
  non-`omit` projection. Tool error texts match because the core's `onError` returns
  `String(error)` for `HarnessToolError` (spec 04 §2). Covered by tests with `MockLanguageModelV4`.

```ts
export interface ProjectionContext {
  message: HarnessUIMessage        // the message that contains the part / the kind message
  sessionId: string
}
```

## 7. Validation on load

Stored data is untrusted (other versions, manual edits, other writers). Validation works on an
in-memory copy; storage is never modified.

```
for each message m (individually — never validate the whole array at once):
  1. apply `upgrade` of each registered data part / kind to its parts
  2. remove parts whose `data-*` type is NOT registered (plugin removed, old data):
     they stay in storage, are skipped by projection, W_UNKNOWN_STORED_PART once per type
     (never escalated by `strict`)
  3. safeValidateUIMessages({
       messages: [m],
       // no `tools`: with tools AI SDK rewrites parts of unknown tools to `dynamic-tool`, and the
       // tool set differs between turns
       metadataSchema,   // LOOSE object schema: keeps unknown keys (app keys and unknown
                         // metadata.eharness keys) because validation replaces message.metadata
                         // with the parsed value
       dataSchemas,      // registry schemas, keyed by name without the `data-` prefix
     })
```

`safeValidateUIMessages` rejects data parts without a schema, which is why step 2 must run first.

A kind message whose kind is not registered is skipped like an unknown part (W_UNKNOWN_STORED_PART
with its `data-<kind>` type), not reported as invalid. A kind message must have exactly one part,
of type `data-<kind>`; otherwise it is invalid. `metadata.eharness`, when present, must have
`v: 1` and a numeric `createdAt`.

Policy `SessionOptions.onInvalidMessage` applies per message: `'drop'` (default: skip that message,
warn `W_INVALID_MESSAGE`), `'keep'` (use the unvalidated copy — only if it is message-shaped, i.e. has a `parts` array;
otherwise it is dropped with the warning), `'throw'` (`EH_INVALID_MESSAGE`).
Validation runs on cold loads only (spec 05 §6), never on hot-path turns.

## 8. Ids

- Message ids and turn ids are **UUIDv7** strings (RFC 9562), lowercase hex with dashes, generated
  by `src/messages/ids.ts` with a monotonic counter so ids created in the same millisecond still
  sort in creation order.
- Lexicographic string order == creation order. `MessageAdapter`s rely on this (spec 05 §4).
- `config.generateId` may replace the generator; it must keep this property (a conformance test
  checks 10k ids in a tight loop).
- **Per-session floor:** a new id must sort after the newest id the session knows (cache or last
  load). If it does not (clock skew between instances, clock going backwards), the core bumps the
  UUIDv7 timestamp field to floor + 1 ms — only then: an id that already sorts after the floor
  (e.g. many ids in one millisecond, each the next one's floor) keeps the clock's timestamp, so
  timestamps never drift ahead of the clock. Implemented as `nextId(floor?: string)` in `ids.ts`.
  The bump applies to that one id only; it does not move the generator's clock, so a skewed floor
  of one session never shifts the ids of other sessions (the session passes its newest id as the
  floor on every call).
- **Exception:** a custom `config.generateId` takes no floor and is not bumped; the core logs a
  warning (`ctx.log.warn`, once per session) when such an id does not sort after the session floor.
- The server always generates user message ids. A client-supplied id is kept only as
  `metadata.eharness.clientId` (useful for optimistic UIs).

## 9. Schema evolution

- Treat every persisted data part / kind schema as public API.
- Additive changes (new optional fields): allowed in minor versions.
- Breaking changes: prefer a new name (`filesystem.change2`), or provide `upgrade(old)`.
- `metadata.eharness.v` changes only with a major version and ships an upgrader.
