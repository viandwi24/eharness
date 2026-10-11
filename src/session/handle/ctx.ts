import type { UIDataTypes, UIMessage, UITools } from 'ai'
import type { AgentInternals } from '../../agent/internals.ts'
import type {
  CollectOptions,
  HarnessRun,
  HarnessSession,
  InboxAdapter,
  MessageAdapter,
  SessionOptions,
  StateAdapter,
  StreamLogAdapter,
} from '../../agent/session-types.ts'
import type { SessionCompaction } from '../../compaction/compact.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import type { HarnessContext, HarnessLogger } from '../../plugin/types.ts'
import type { EventHub } from '../events.ts'
import type { InboxDrain } from '../inbox/driver.ts'
import type { NormalizedInput } from '../input.ts'
import type { DeferredRun, QueuedTurn } from '../interaction/queue.ts'
import type { WaitOps } from '../interaction/resolve.ts'
import type { RateLimitedWarn } from '../rate-limit.ts'
import type { OpenSession, SessionRuntime } from '../runtime.ts'
import type { RunningTurn, TurnHost } from '../turn/ctx.ts'

/** What the agent passes to `createSessionHandle`. */
export interface SessionHandleArgs {
  internals: AgentInternals
  owner: string
  /** Owner string of inbox claims (unique per agent incarnation). */
  claimOwner: string
  id: string
  options: SessionOptions
  /** Open another session of the agent (`agent.session`), for `fork()`. */
  openSession(
    id: string,
    options: SessionOptions,
  ): HarnessSession<UIMessage, Record<string, unknown>>
  /** A live handle of `id` is cached in the agent. */
  isLive(id: string): boolean
  messages: MessageAdapter
  state: StateAdapter
  /** Optional durable inbox (spec 05 §12). */
  inbox?: InboxAdapter
  /** Optional stream log (spec 04 §6.2). */
  streams?: StreamLogAdapter
  idleMs: number
  onClosed(): void
  /** The close of the previous live handle of this id: this handle opens only after it. */
  after?: Promise<void>
}

/** How long `attachRemote` waits for the owner's first flush after the turn's commit point. */
export const REMOTE_START_GRACE_MS = 3_000

/** A live session plus the handles the agent needs. */
export interface SessionHandle {
  readonly session: HarnessSession<UIMessage, Record<string, unknown>>
  readonly rt: SessionRuntime
  close(): Promise<void>
}

/** One input of an open `collect` burst. */
export type CollectEntry = {
  input: NormalizedInput
  inboxId?: string
  key?: string
  at: number
  handle?: DeferredRun
}

/**
 * The state of one live session: what `createSessionHandle` used to keep in closure variables. The
 * functions of this folder (`open`, `queue`, `inbox`, `api-*`) take it as their first argument.
 */
export interface SessionCtx {
  args: SessionHandleArgs
  internals: AgentInternals
  id: string
  config: AgentInternals['config']
  log: HarnessLogger
  closeController: AbortController
  /** `ctx.signal`: aborts on close, and when an open fails (a retried open gets a fresh one). */
  sessionController: AbortController
  warnLimited: RateLimitedWarn
  events: EventHub
  contexts: Map<string, HarnessContext<Record<never, never>>>
  customIdWarned: boolean
  rt: SessionRuntime
  // ─── open (state load + plugin session phases) ────────────────────────────────────────────
  opening?: Promise<OpenSession> | undefined
  /** The state was just loaded by open(); the first context load must not reload it. */
  stateFresh: boolean
  pluginOrder: string[]
  // ─── context (cold load / hot cache validation) ───────────────────────────────────────────
  /** The in-flight cold load: every caller awaits the same one (single flight). */
  loading?: Promise<void> | undefined
  /** Messages cached while a load is in flight (the load may have read storage before them). */
  cachedWhileLoading?: HarnessUIMessage[] | undefined
  debugInvariants: boolean
  compaction: SessionCompaction
  // ─── turns ────────────────────────────────────────────────────────────────────────────────
  /** The drain of the durable inbox (`storage.inbox`), created at the end of this function. */
  drain?: InboxDrain | undefined
  /** Caller ids of `enqueue()` without an inbox: id to item id (this session object's life). */
  localEnqueueIds: Map<string, string>
  current?: RunningTurn | undefined
  /** Queued send turns (spec 11 §6.2): in memory, per live session, dropped on abort/close. */
  queue: QueuedTurn[]
  /**
   * Direct `send()`s of an idle session with a durable inbox, held until the inbox has nothing
   * older to apply (spec 05 §12 rule 7: a direct send never overtakes a queued item).
   */
  gated: QueuedTurn[]
  gating: boolean
  /** External waits (spec 11 §4.2): resolve / expire, durable timer items, the live timer. */
  waits: WaitOps
  host: TurnHost
  /**
   * A queue held by pending approvals of this handle's cache: another instance may have answered
   * them (its `respond()` / `resolveWait()` never reaches this process). Called after every inbox
   * pass: when the stored pending state no longer is the one holding the queue, start it (the
   * turn reloads state and messages at its commit point, like a gated send). Without this a
   * queued or waiting send would wait for an operation of its own process forever (fuzz seed 51).
   */
  revalidating: boolean
  /** `session.onRun()` listeners (in-process, spec 05 §2). */
  runListeners: Set<(run: HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never>) => void>
  /** The open burst of `collect` inputs of this process (no inbox, or `send(…, 'collect')`). */
  collecting?:
    | {
        turnId: string
        options: Required<CollectOptions>
        entries: CollectEntry[]
        timer?: ReturnType<typeof setTimeout>
      }
    | undefined
  // ─── idle ─────────────────────────────────────────────────────────────────────────────────
  idleWaiters: Array<() => void>
  // ─── idle eviction ────────────────────────────────────────────────────────────────────────
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  // ─── close ────────────────────────────────────────────────────────────────────────────────
  closing?: Promise<void> | undefined
  injectFlights: Map<string, Promise<{ message: unknown; run?: unknown }>>
  session: HarnessSession<UIMessage, Record<string, unknown>>
  staleForDrain: number | false
}
