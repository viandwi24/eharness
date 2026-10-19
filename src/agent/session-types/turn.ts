/**
 * Turn-level types: session/send options, busy/abort, usage, pending responses.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type { FileUIPart, FlexibleSchema, JSONValue, LanguageModel, UIMessage } from 'ai'
import type { TurnKind } from '../../messages/types.ts'
import type { OutputSpec } from '../../output/types.ts'
import type {
  ClientToolDeclaration,
  ClientToolsOptions,
  PageContextEntry,
  PageContextOptions,
} from '../../registry/request-tools.ts'
import type { ModelSettings } from '../types.ts'
import type { CollectOptions, InboxAdapter } from './inbox.ts'
import type { MessageAdapter, ParentInfo, SessionLock, StateAdapter } from './storage.ts'
import type { StreamLogAdapter } from './stream-log.ts'

/**
 * The turn currently running somewhere (crash recovery).
 *
 * @see docs/specs/05-session-and-storage.md#9-crash-recovery
 */
export interface ActiveTurn {
  turnId: string
  kind: TurnKind
  messageId: string
  userMessageId?: string
  owner: string
  startedAt: number
  heartbeatAt: number
}

/**
 * Cumulative usage of a session: all finished turns (`state.core.usage`). `costUsd` is present
 * once anything was priced (spec 12).
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  /** Turns that ran at least one model step. */
  turns: number
  costUsd?: number
}

/**
 * Outcome of `session.recover()`: the interrupted turn that was repaired, or why nothing was
 * (`idle`: no stored active turn; `live`: a live turn of another instance; `locked`: the session
 * lock is held elsewhere (contention); `lock-unavailable`: the lock service failed, logged;
 * `disabled`: `recovery: false`).
 *
 * @see docs/specs/05-session-and-storage.md#92-recover-now-stable-instance-id-adr-0056
 */
export type RecoverResult =
  | { recovered: true; turnId: string; messageId: string }
  | { recovered: false; reason: 'idle' | 'live' | 'locked' | 'lock-unavailable' | 'disabled' }

/**
 * A running turn as reported by `session.busy()`.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export interface SessionBusy {
  scope: 'local' | 'remote'
  turnId: string
  /** Owner (instance) of the turn; remote turns only. */
  owner?: string
  /** Epoch ms of the last heartbeat; remote turns only. */
  heartbeatAt?: number
}

/**
 * A request, written by another instance, to abort the turn `turnId` (cross-process abort). The
 * only `state.core` field a foreign instance may write while a turn runs.
 *
 * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
 */
export interface AbortRequest {
  /** The turn to abort; an owner ignores (and clears) a request for any other turn. */
  turnId: string
  /** Epoch ms of the request. */
  at: number
  /** Abort reason (the terminal `abort` chunk's `reason`). */
  reason?: string
  /** Instance id of the requester. */
  by?: string
}

/**
 * Where `session.abort()` sent the abort: a turn of this process (`'local'`), a turn running
 * in another instance (`'remote'`), nowhere because no turn runs (`'idle'`), or nowhere because the
 * storage cannot carry the request (`'unsupported'`: no `StateAdapter.setIf`, or `recovery: false`).
 *
 * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
 */
export interface AbortRequestResult {
  target: 'local' | 'remote' | 'idle' | 'unsupported'
}

/**
 * Options of `agent.session(id, options)`.
 *
 * @see docs/specs/05-session-and-storage.md#1-session-options
 */
export interface SessionOptions {
  storage?: {
    messages?: MessageAdapter
    state?: StateAdapter
    inbox?: InboxAdapter
    streams?: StreamLogAdapter
  }
  runtime?: Record<string, unknown>
  /** AI SDK `toolsContext`: map keyed by final tool name. */
  toolsContext?: Record<string, unknown>
  lock?: SessionLock
  /** Policy for invalid stored messages. Default `'drop'`. */
  onInvalidMessage?: 'drop' | 'keep' | 'throw'
  /** Keep app-level metadata keys sent by the client on user messages. Default false. */
  acceptClientMetadata?: boolean
  /** Marks a child session (subagent). Depth > 8 is rejected. */
  parent?: ParentInfo
}

/**
 * Input of `send()` / `edit()`.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export type SendInput = string | { text?: string; files?: FileUIPart[] } | UIMessage

/**
 * Per-call options of turn operations.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export interface SendOptions {
  /**
   * While a turn runs: reject (default, `EH_SESSION_BUSY`), queue or steer (`send()` only), or
   * `'wait'` (`send()` and `respond()`): wait for the running turn and the queue ahead, then run.
   * A waiting `send()` is held while approvals created by a turn it waited for are pending (it
   * never denies them); `abortSignal` drops it while it waits (`stop: 'aborted'`). `'collect'`
   * (`send()` only): merged with other collected inputs into one queued turn (`collect`).
   */
  ifBusy?: 'reject' | 'queue' | 'steer' | 'wait' | 'collect'
  /** Debounce of `ifBusy: 'collect'` (defaults: `config.inbox.collect`, then 1 500 / 10 000 / 20). */
  collect?: CollectOptions
  model?: LanguageModel
  settings?: Partial<ModelSettings>
  /** Validated with `config.callOptions`. */
  options?: unknown
  /** Overrides `loop.maxSteps` for this turn. */
  maxSteps?: number
  abortSignal?: AbortSignal
  runtime?: Record<string, unknown>
  toolsContext?: Record<string, unknown>
  /**
   * Ask this turn for a typed final answer (0.4.0): validated against `output.schema`, retried on
   * invalid answers, returned as `TurnResult.output`. Server-side only (`handleChatRequest` never
   * reads it from a request body); not carried over a `'tool-pending'` stop — pass it again to
   * `respond()`. With `ifBusy: 'steer'` or `'collect'` the run fails with `EH_INVALID_INPUT`
   * (`details.reason: 'output-with-steer-or-collect'`). Spec 05 §3.3.
   */
  output?: OutputSpec
  /**
   * Client tools declared for this turn only (0.5.0, spec 11 §7.1): AI SDK tools without
   * `execute` built from the declarations, answered by the client (`respond()`). Untrusted:
   * validated all-or-nothing (names, schema size, collisions with server tools; run error
   * `EH_INVALID_INPUT`, `details.reason: 'client-tools'`), no implied permission (approval rules
   * apply), appended after the static tools. Re-declare them on `respond()`; not carried over a
   * `'tool-pending'` stop. `handleChatRequest` reads them from the body only when enabled.
   */
  clientTools?: ClientToolDeclaration[]
  /** Limits and filters of {@link SendOptions.clientTools} (`allow`, `maxTools`, `timeoutMs`, …). */
  clientToolsOptions?: ClientToolsOptions
  /**
   * Page context for this turn only (0.5.0, spec 11 §7.1 rule 6): delivered in the turn reminder,
   * framed as data (tags neutralised, capped), never stored and never in `instructions`.
   */
  pageContext?: PageContextEntry[]
  /** Limits of {@link SendOptions.pageContext} (`maxChars`, default 4 000). */
  pageContextOptions?: PageContextOptions
  /**
   * `respond()` only (0.7.0, spec 11 §4): end the turn after the answers are recorded and the
   * approved tools ran, without calling the model. `'after-answers'`: always. `'if-denied'`: only
   * when at least one approval was denied (otherwise the model continues as usual). The turn
   * stops `'complete'` with `steps: 0`; the next `send()` continues normally. Ignored when the
   * answers park approved client-tool calls (the turn stops `'tool-pending'` anyway). Server side
   * only (`handleChatRequest` passes it through, a request body cannot set it).
   */
  endTurn?: 'after-answers' | 'if-denied'
}

/** {@link SendOptions} with a typed {@link OutputSpec} (the `send()` overload that types `output`). */
export type SendOptionsWithOutput<S extends FlexibleSchema> = SendOptions & {
  output: OutputSpec<S>
}

/**
 * Options of `session.inject()`.
 *
 * @see docs/specs/11-interaction.md
 */
export interface InjectOptions {
  deliver?: 'next-turn' | 'next-step'
  wake?: boolean
  /**
   * Idempotency key (max 200 characters). When one of the newest 200 stored messages of the
   * session already carries this key the call saves, delivers and wakes nothing and returns that
   * message. Read from storage, so it holds across instances and retries; two instances racing
   * within the same few milliseconds can still both save (best effort, spec 11 §6.3).
   */
  key?: string
}

/**
 * Who answered an approval (spec 11 §3.2). `id` is the application's user id; the object is
 * passed to `approval.decided` hooks as given (JSON values only).
 */
export interface ApprovalActor {
  id: string
  name?: string
  [key: string]: JSONValue | undefined
}

/**
 * Answers to pending approvals / client tool calls.
 *
 * @see docs/specs/11-interaction.md#4-respond
 */
export interface PendingResponse {
  approvals?: Array<{
    id: string
    approved: boolean
    reason?: string
    remember?: 'once' | 'session'
    /** Who answered (for audit, `approval.decided`); never sent to the model. */
    actor?: ApprovalActor
    /**
     * A free-text note of the human about this call (0.7.0, max 4 000 characters, else
     * `EH_INVALID_INPUT`). Approved: the model reads it on the first step of the continuation,
     * right after the tool result, framed as `<user-note tool="…" call="…">…</user-note>` and
     * stored as a `data-eh.input` part (spec 11 §3.6). Denied: appended to the `reason`. Server
     * side only: AI SDK's UI approval object has no note, so `handleChatRequest` never reads one.
     */
    note?: string
  }>
  toolOutputs?: Array<
    { toolCallId: string; output: unknown } | { toolCallId: string; errorText: string }
  >
  /**
   * Results of external waits (`externalTool()`, 0.5.0), answered all at once with the rest. An
   * external wait whose result `resolveWait()` already recorded is used as recorded and must not
   * be answered again here. A client output for an external call is `EH_INVALID_INPUT`
   * (`'wrong-kind'`): only the server resolves waits.
   */
  externals?: Array<{ waitId: string; output: unknown } | { waitId: string; errorText: string }>
}
