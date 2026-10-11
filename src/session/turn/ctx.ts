import type { LanguageModel, UIMessage, UIMessageChunk, UIMessageStreamWriterWithOutcome } from 'ai'
import type {
  ActiveTurn,
  HarnessRun,
  PendingResponse,
  SendInput,
  SendOptions,
  SteerDelivery,
} from '../../agent/session-types.ts'
import type { BudgetLedgerConfig } from '../../agent/types.ts'
import type { SessionCompaction } from '../../compaction/compact.ts'
import type { TurnLedger } from '../../loop/ledger.ts'
import type { UsageTotals } from '../../loop/usage.ts'
import type {
  HarnessUIMessage,
  PendingState,
  StopReason,
  TurnKind,
  TurnResult,
} from '../../messages/types.ts'
import type { TurnOutput } from '../../output/turn.ts'
import type { TurnInfo } from '../../plugin/types.ts'
import type { TurnRegistry } from '../../registry/turn.ts'
import type { TurnError } from '../../stream/describe-error.ts'
import type { StreamLogWriter } from '../../stream/log-writer.ts'
import type { TurnBuffer } from '../../stream/run.ts'
import type { InboxSettle, InboxUnit } from '../inbox/driver.ts'
import type { NormalizedInput } from '../input.ts'
import type { TurnInputQueue } from '../interaction/inbox.ts'
import type { ClientToolAnswer, RespondPlan } from '../interaction/pending.ts'
import type { AbortPoll } from '../remote-abort.ts'
import type { OpenSession, SessionRuntime, TurnState } from '../runtime.ts'
import type { StateCheckpoint } from '../state.ts'

/** A turn request. */
export interface TurnOperation {
  kind: TurnKind
  input: SendInput | undefined
  options: SendOptions
  queued: boolean
  /** Preset turn id (a queued run exposes its turn id before the turn starts). */
  turnId?: string
  /** Input normalized when it was queued (skips normalization). */
  normalized?: NormalizedInput
  /** Input that already passed `input.submit` (an undelivered steer, spec 11 §6.1). */
  submitted?: { input: NormalizedInput; contexts: string[] }
  /** `via` of `input.submit` (default `'send'`). */
  via?: 'send' | 'edit' | 'queue'
  /** `respond()` answers; `ignoreUnknown` skips answers that are not pending (handleChatRequest). */
  respond?: { response: PendingResponse; ignoreUnknown: boolean }
  /** `regenerate()` / `edit()` target (message id or client id). */
  target?: string
  /**
   * Inbox items this turn applies (`session.enqueue()`, spec 05 §12): acked once the user
   * message is saved at the commit point; a `durable` wake turn (an `InboxAdapter`) records its
   * ids in `state.core.inboxDelivered` with the end-of-turn state write and is acked after it.
   */
  inbox?: { ids: string[]; meta: InboxUnit['meta']; durable: boolean }
}

/** What the session provides to a turn. */
export interface TurnHost {
  rt: SessionRuntime
  /** Open the session (state load + plugin session phases). */
  ensureOpen(): Promise<OpenSession>
  /** Load the context (cold) or validate the hot cache (`lastId`). */
  ensureContext(): Promise<void>
  /** Save messages (after `message.beforeSave`) and cache them. Throws `EH_STORAGE`. */
  persist(messages: HarnessUIMessage[]): Promise<HarnessUIMessage[]>
  /** Token accounting and compaction of the session (spec 06). */
  compaction: SessionCompaction
  /** Called when the turn fully ended (running flag cleared). */
  onTurnEnd(): void
  /** Queue an undelivered steer as a `send` turn (spec 11 §6.1); inbox steers go back to the inbox. */
  enqueueSteer(
    submitted: { input: NormalizedInput; contexts: string[] },
    inboxId?: string,
  ): Promise<void> | undefined
  /** The session has a durable inbox (`storage.inbox`). */
  readonly inboxDurable: boolean
  /** Inbox items whose effect is durable now: ack them (spec 05 §12 rule 5). */
  inboxApplied(ids: string[], turnId: string): void
  /** Inbox items this turn did not apply (spec 05 §12 rules 3, 11, 13). */
  inboxNotApplied(ids: string[], outcome: InboxSettle): void
  /**
   * Queue a no-input wake turn for injections that were not delivered (spec 11 §6.3). With a
   * durable inbox and a turn that stopped `tool-pending` the wake is stored as inbox items of
   * `messageIds` (any instance runs it once the pending items are answered, ADR-0054).
   */
  enqueueWake(messageIds: string[], pending: boolean): Promise<void>
  /** Drop queued turns like `session.abort()` (a cross-process abort, spec 05 §9.1). */
  dropQueue(): void
  /**
   * The turn parked on external waits and its pending state is stored: enqueue the durable
   * `wait-timeout` items and arm the live timer (spec 11 §4.2 rule 6). Never throws.
   */
  waitsParked(pending: PendingState): Promise<void>
}

/** The running turn as seen by the session (attach, abort, steer, next-step delivery). */
export interface RunningTurn {
  run: HarnessRun<UIMessage>
  buffer: TurnBuffer
  abort(reason?: string): void
  /**
   * Steer the running turn: `input.submit` (`via: 'steer'`) now, delivery at the next step
   * boundary (spec 11 §6.1). False when the turn no longer takes input.
   */
  steer(
    input: NormalizedInput,
    inboxId?: string,
    settle?: (outcome: SteerDelivery) => void,
  ): boolean
  /**
   * Deliver a saved kind message into the running turn (`next-step`, spec 11 §6.3). With `wake`,
   * an undelivered event queues a wake turn. False when the turn no longer takes input.
   */
  deliverEvent(message: HarnessUIMessage, text: string, wake?: boolean): boolean
}

export const DEFAULT_MAX_STEPS = 500
export const DEFAULT_MAX_IDLE_CONTINUES = 3
export const DEFAULT_STALE_MS = 120_000

export type Outcome = {
  stop: StopReason
  error?: TurnError
  pending?: PendingState
  steps: number
  model: LanguageModel
  abortReason?: string
  /** A partial `respond()` recorded its answers; nothing continued (ADR-0044). */
  partial?: true
}

/** What `prepare` decides (spec 05 §3 steps 1-10): nothing is persisted yet. */
export type Prepared =
  | { kind: 'aborted' }
  | { kind: 'partial'; pending: PendingState }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'turn'
      open: OpenSession
      registry: TurnRegistry | undefined
      stale: ActiveTurn | undefined
      user: HarnessUIMessage | undefined
      blockNotice: HarnessUIMessage | undefined
      recoveryNoticeId: string | undefined
      toolsContext: Record<string, unknown> | undefined
      activeTools: string[] | undefined
    }

/**
 * The state of one running turn: what `startTurn` used to keep in closure variables. The phase
 * functions of this folder (`output`, `prepare`, `commit`, `body`, `end`, ...) take it as their
 * first argument; `startTurn` creates it.
 */
export interface TurnCtx {
  host: TurnHost
  op: TurnOperation
  rt: SessionRuntime
  config: SessionRuntime['agent']['config']
  hookTimeoutMs: number
  log: (m: string, d?: Record<string, unknown> | undefined) => void
  turnId: string
  startedAt: number
  recovery: boolean
  staleMs: number
  // cross-process abort (spec 05 §9.1): only an adapter with setIf can carry a request
  abortPollMs: number
  abortPoll?: AbortPoll | undefined
  controller: AbortController
  timedOut: boolean
  external: AbortSignal | undefined
  onExternalAbort: () => void
  turnTimer?: ReturnType<typeof setTimeout> | undefined
  timeoutMs: number | undefined
  heartbeatTimer?: ReturnType<typeof setInterval> | undefined
  buffer: TurnBuffer
  /** Drainer to `storage.streams` (spec 04 §6.2): starts at the commit point, owner only. */
  streamLog: StreamLogWriter | undefined
  writer?: UIMessageStreamWriterWithOutcome<UIMessage> | undefined
  startWritten: boolean
  committed: boolean
  assistantId?: string | undefined
  releaseLock?: (() => Promise<void>) | undefined
  stateCheckpoint?: StateCheckpoint | undefined
  outcome: Outcome
  created: HarnessUIMessage[]
  createdBeforeAssistant: number
  usage: UsageTotals
  /** `budget.ledger` of this turn (spec 12 §4.1). */
  ledgerConfig: BudgetLedgerConfig | undefined
  ledger: TurnLedger | undefined
  /** `SendOptions.output` of this turn (spec 05 §3.3), set at preparation step 6. */
  turnOutput?: TurnOutput | undefined
  // ─── interaction state (spec 11) ──────────────────────────────────────────────────────────
  /** Steers and next-step injections waiting for a step boundary. */
  inbox: TurnInputQueue
  /** Validated respond() answers. */
  plan?: RespondPlan | undefined
  /**
   * Approved calls of tools without `execute` (client tools): the continuation does not run a
   * step; it parks them as client calls (spec 11 §5). Set at the commit point.
   */
  parkedPending?: PendingState | undefined
  /** Tool call ids of `parkedPending` and of approved server calls kept pending beside them. */
  parkedCalls: Set<string>
  deferredCalls: Set<string>
  /** Pending state denied by this turn's new input (`onNewInput: 'deny'`). */
  denyPending?: PendingState | undefined
  /** The eh.rewind marker of regenerate/edit (saved at the commit point). */
  rewind?: HarnessUIMessage | undefined
  /** `originalMessages` of the stream: `[A']` for a respond continuation. */
  original?: UIMessage[] | undefined
  /** The continued message A' (fallback of the final save). */
  baseMessage?: HarnessUIMessage | undefined
  /** Client tool outputs of respond(), after tool.after and output limits. */
  clientOutputs: ClientToolAnswer[]
  /** Kind messages delivered as data-eh.input (updated with deliveredIn after a save). */
  deliveredEvents: Array<{ message: HarnessUIMessage; afterFinish: number; done: boolean }>
  /** Inbox steers delivered as data-eh.input (acked once a saved snapshot contains them). */
  deliveredSteers: Array<{ inboxId: string; afterFinish: number; done: boolean }>
  /** Inbox ids of the steers this turn took (`steer()` is idempotent per inbox id). */
  steerIds: Set<string>
  /**
   * A wake turn made from durable inbox items: its ids go to `state.core.inboxDelivered` with
   * the end-of-turn state write and are acked after it (its effect is the saved reply).
   */
  wakeFromInbox: boolean
  /** The op's inbox items were acked or released. */
  inboxSettled: boolean
  /** Ids of kind messages pushed into the inbox: never projected standalone in this turn. */
  inboxed: Set<string>
  /** Session grants before this respond() recorded new ones (those apply from step 1, §3.1). */
  grantsBefore?: Record<string, 'always' | 'never'> | undefined
  grantsRecorded: boolean
  /** Chunks written before `start` (transient warnings), flushed right after it. */
  preStart: UIMessageChunk[]
  finishExecute?: (() => void) | undefined
  finishStepsWritten: number
  stepEndsDone: number
  drained: boolean
  wakeBarrier?: (() => void) | undefined
  resolveMessageId: (id: string) => void
  messageId: Promise<string>
  resolveResult: (result: TurnResult<UIMessage>) => void
  result: Promise<TurnResult<UIMessage>>
  resolveAccepted: (error: TurnError | undefined) => void
  accepted: Promise<TurnError | undefined>
  info: TurnInfo
  turnState: TurnState
  /** Tool calls written to the stream that have no final result yet (toolCallId → open). */
  openCalls: Set<string>
  /** Calls answered with `INTERRUPTED_TURN` chunks at the end of the turn. */
  interrupted: Set<string>
  /**
   * The terminal `finish` / `abort` chunk of the turn stream: AI SDK gets it now (its `onEnd` runs
   * the end sequence), readers of `run.stream` only after the end sequence completed, so the end
   * of the stream implies the session is free (spec 05 §3 step 17).
   */
  terminal?: UIMessageChunk | undefined
  // ─── plugin state set by this turn before its commit point ───────────────────────────────
  /** Plugin keys set by this turn's preparation hooks (reverted when it ends before committing). */
  touched: Map<string, { plugin: string; key: string }>
  /** Owners whose preparation hook (or tool source / instruction) is running, with a count. */
  preparing: Map<string, number>
  stopObserving: () => void
  /** Heartbeat (spec 05 §9) and abort poll (§9.1): step ends and the heartbeat timer. */
  heartbeatInFlight: boolean
  // ─── end sequence (spec 05 §3 step 17) ────────────────────────────────────────────────────
  ended: boolean
  lastStepMessage?: HarnessUIMessage | undefined
  abort: (reason?: string | undefined) => void
  run: HarnessRun<UIMessage>
  /** Create the UI stream (at `start`; wired by `startTurn` so `write` need not import `stream.ts`). */
  openStream: () => void
}
