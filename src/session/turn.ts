/**
 * The turn lifecycle (internal): preparation (nothing persisted), commit point, step loop and
 * the end sequence in `onEnd`.
 *
 * @see docs/specs/05-session-and-storage.md#3-turn-lifecycle-normative-order
 * @see docs/specs/04-streaming.md#2-turn-stream-structure
 */
import {
  asSchema,
  createUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriterWithOutcome,
} from 'ai'
import type {
  ActiveTurn,
  HarnessRun,
  PendingResponse,
  SendInput,
  SendOptions,
} from '../agent/session-types.ts'
import type { BudgetConfig } from '../agent/types.ts'
import type { BudgetOverrun, SessionCompaction } from '../compaction/compact.ts'
import { createTurnCompaction } from '../compaction/turn-context.ts'
import { currentTurnStartId } from '../compaction/turns.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
import { createTurnLedger, DEFAULT_RESERVATION_TTL_MS } from '../loop/ledger.ts'
import {
  addUsage,
  emptyUsage,
  type LoopResult,
  mergeSettings,
  runSteps,
  toolSearchNames,
  type UsageTotals,
} from '../loop/steps.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { DENIED_NEW_INPUT, INTERRUPTED_CRASH, INTERRUPTED_TURN } from '../messages/texts.ts'
import { answerDanglingToolParts } from '../messages/tool-parts.ts'
import type {
  HarnessUIMessage,
  HarnessUsageMeta,
  PendingState,
  StopReason,
  TurnKind,
  TurnResult,
} from '../messages/types.ts'
import { costOf } from '../models/cost.ts'
import { prepareTurnOutput, type TurnOutput, withOutputTool } from '../output/turn.ts'
import type { TurnInfo } from '../plugin/types.ts'
import type { ToolOutputSink } from '../registry/output-limits.ts'
import { resolveTurnRegistry, type TurnRegistry } from '../registry/turn.ts'
import { finishToolOutput, hookFailed, reportDecision } from '../registry/wrap.ts'
import { describeError } from '../stream/describe-error.ts'
import { createRun, createTurnBuffer, type TurnBuffer } from '../stream/run.ts'
import { forgetDelivered, recordDelivered } from './inbox/dedupe.ts'
import type { InboxSettle, InboxUnit } from './inbox/driver.ts'
import { buildUserMessage, type NormalizedInput, normalizeInput } from './input.ts'
import { createTurnInputQueue, type PendingInput } from './interaction/inbox.ts'
import {
  type ClientToolAnswer,
  patchForNewInput,
  patchForRespond,
  planRespond,
  type RespondPlan,
} from './interaction/pending.ts'
import { createRewind, type RewindTarget, resolveRewindTarget } from './interaction/rewind.ts'
import { pendingCallIds } from './interaction/waits.ts'
import { hiddenByRewind } from './load-context.ts'
import { type AbortPoll, createAbortPoll, DEFAULT_ABORT_POLL_MS } from './remote-abort.ts'
import type { OpenSession, SessionRuntime, TurnState } from './runtime.ts'
import type { StateCheckpoint } from './state.ts'

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
  /** Queue a no-input wake turn for an injection that was not delivered (spec 11 §6.3). */
  enqueueWake(): void
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
  steer(input: NormalizedInput, inboxId?: string): boolean
  /**
   * Deliver a saved kind message into the running turn (`next-step`, spec 11 §6.3). With `wake`,
   * an undelivered event queues a wake turn. False when the turn no longer takes input.
   */
  deliverEvent(message: HarnessUIMessage, text: string, wake?: boolean): boolean
}

const DEFAULT_MAX_STEPS = 500
const DEFAULT_MAX_IDLE_CONTINUES = 3
const DEFAULT_STALE_MS = 120_000

type TurnError = { code?: string; message: string; details?: Record<string, unknown> }

type Outcome = {
  stop: StopReason
  error?: TurnError
  pending?: PendingState
  steps: number
  model: LanguageModel
  abortReason?: string
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

function toTurnError(
  error: unknown,
  log: (m: string, d?: Record<string, unknown>) => void,
): TurnError {
  const message = describeError(error, log)
  if (!isHarnessError(error)) return { message }
  return error.details === undefined
    ? { code: error.code, message }
    : { code: error.code, message, details: structuredClone(error.details) }
}

/** The stored / streamed error of `metadata.eharness.error` (`details` stay in `run.result`). */
function metaError(error: TurnError | undefined): { code?: string; message: string } | undefined {
  if (error === undefined) return undefined
  const { details: _details, ...rest } = error
  return rest
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v
  return out as T
}

/** Seed tool-search discoveries from the loaded context (spec 02 §3.3). */
function seedDiscovered(view: readonly HarnessUIMessage[]): Set<string> {
  const out = new Set<string>()
  for (const message of view) {
    for (const part of message.parts) {
      if (part.type !== 'tool-tool_search') continue
      const tool = part as { state?: string; output?: unknown }
      if (tool.state === 'output-available')
        for (const n of toolSearchNames(tool.output)) out.add(n)
    }
  }
  return out
}

/**
 * The used-up USD budget (spent ≥ limit), turn first (spec 12 §4); `undefined` when none is.
 * `sessionCost` is the cost of the session's earlier turns.
 */
export function budgetOverrun(
  budget: BudgetConfig | undefined,
  turnCost: number,
  sessionCost: number,
): BudgetOverrun | undefined {
  if (budget === undefined) return undefined
  const checks: Array<['turn' | 'session', number | undefined, number]> = [
    ['turn', budget.maxTurnUsd, turnCost],
    ['session', budget.maxSessionUsd, sessionCost + turnCost],
  ]
  for (const [scope, limitUsd, spentUsd] of checks) {
    if (limitUsd === undefined || !(limitUsd >= 0)) continue
    if (spentUsd >= limitUsd) return { scope, limitUsd, spentUsd }
  }
  return undefined
}

/** Validate a value against a schema; returns the (possibly transformed) value. */
async function validateWith(schema: unknown, value: unknown, what: string): Promise<unknown> {
  const validate = asSchema(schema as Parameters<typeof asSchema>[0]).validate
  if (validate === undefined) return value
  const result = await validate(value)
  if (result.success) return result.value
  throw new HarnessError('EH_INVALID_INPUT', `${what} is invalid: ${result.error.message}`, {
    cause: result.error,
  })
}

/**
 * Start a turn. The caller has checked and set the running flag. Returns immediately; the turn
 * runs inside the stream's `execute`, the end sequence in `onEnd`.
 */
export function startTurn(host: TurnHost, op: TurnOperation): RunningTurn {
  const { rt } = host
  const config = rt.agent.config
  const log = (m: string, d?: Record<string, unknown>) => rt.log.error(m, d)
  const turnId = op.turnId ?? rt.agent.generateId()
  const startedAt = Date.now()
  const recovery = config.recovery !== false
  const staleMs =
    (config.recovery === false ? undefined : config.recovery?.staleMs) ?? DEFAULT_STALE_MS
  // cross-process abort (spec 05 §9.1): only an adapter with setIf can carry a request
  const abortPollMs =
    config.recovery === false || !rt.state.canCas
      ? 0
      : (config.recovery?.abortPollMs ?? DEFAULT_ABORT_POLL_MS)
  let abortPoll: AbortPoll | undefined

  const controller = new AbortController()
  let timedOut = false
  const external = op.options.abortSignal
  const onExternalAbort = () => controller.abort(external?.reason ?? 'aborted')
  if (external?.aborted) onExternalAbort()
  else external?.addEventListener('abort', onExternalAbort, { once: true })
  let turnTimer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = config.loop?.turnTimeoutMs
  if (timeoutMs !== undefined && timeoutMs > 0) {
    turnTimer = setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, timeoutMs)
    unref(turnTimer)
  }
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const buffer = createTurnBuffer()
  let writer: UIMessageStreamWriterWithOutcome<UIMessage> | undefined
  let startWritten = false
  let committed = false
  let assistantId: string | undefined
  let releaseLock: (() => Promise<void>) | undefined
  let stateCheckpoint: StateCheckpoint | undefined
  let outcome: Outcome = { stop: 'error', steps: 0, model: config.model }
  const created: HarnessUIMessage[] = []
  let createdBeforeAssistant = 0
  const usage: UsageTotals = emptyUsage()
  /** `budget.ledger` of this turn (spec 12 §4.1). */
  const ledgerConfig = config.budget?.ledger
  const ledger =
    ledgerConfig === undefined
      ? undefined
      : createTurnLedger({
          config: ledgerConfig,
          models: config.models,
          sessionId: rt.id,
          turnId,
          ttlMs:
            ledgerConfig.reservationTtlMs ??
            (timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_RESERVATION_TTL_MS),
          ctx: () => rt.contextOf('app'),
          warn: (warning, key) => rt.warn(warning, key),
        })
  /** `SendOptions.output` of this turn (spec 05 §3.3), set at preparation step 6. */
  let turnOutput: TurnOutput | undefined

  // ─── interaction state (spec 11) ──────────────────────────────────────────────────────────
  /** Steers and next-step injections waiting for a step boundary. */
  const inbox = createTurnInputQueue()
  /** Validated respond() answers. */
  let plan: RespondPlan | undefined
  /** Pending state denied by this turn's new input (`onNewInput: 'deny'`). */
  let denyPending: PendingState | undefined
  /** The eh.rewind marker of regenerate/edit (saved at the commit point). */
  let rewind: HarnessUIMessage | undefined
  /** `originalMessages` of the stream: `[A']` for a respond continuation. */
  let original: UIMessage[] | undefined
  /** The continued message A' (fallback of the final save). */
  let baseMessage: HarnessUIMessage | undefined
  /** Client tool outputs of respond(), after tool.after and output limits. */
  let clientOutputs: ClientToolAnswer[] = []
  /** Kind messages delivered as data-eh.input (updated with deliveredIn after a save). */
  const deliveredEvents: Array<{ message: HarnessUIMessage; afterFinish: number; done: boolean }> =
    []
  /** Inbox steers delivered as data-eh.input (acked once a saved snapshot contains them). */
  const deliveredSteers: Array<{ inboxId: string; afterFinish: number; done: boolean }> = []
  /** Inbox ids of the steers this turn took (`steer()` is idempotent per inbox id). */
  const steerIds = new Set<string>()
  /**
   * A wake turn made from durable inbox items: its ids go to `state.core.inboxDelivered` with
   * the end-of-turn state write and are acked after it (its effect is the saved reply).
   */
  const wakeFromInbox = op.kind === 'wake' && op.inbox?.durable === true
  /** The op's inbox items were acked or released. */
  let inboxSettled = false
  /** Ids of kind messages pushed into the inbox: never projected standalone in this turn. */
  const inboxed = new Set<string>()
  /** Session grants before this respond() recorded new ones (those apply from step 1, §3.1). */
  let grantsBefore: Record<string, 'always' | 'never'> | undefined
  let grantsRecorded = false
  function currentGrants(): Readonly<Record<string, 'always' | 'never'>> | undefined {
    if (grantsRecorded && (turnState.step?.index ?? 0) === 0) return grantsBefore
    return rt.state.core().grants
  }
  /** Chunks written before `start` (transient warnings), flushed right after it. */
  const preStart: UIMessageChunk[] = []
  let finishExecute: (() => void) | undefined

  let finishStepsWritten = 0
  let stepEndsDone = 0
  let drained = false
  let wakeBarrier: (() => void) | undefined
  const barrier = (): Promise<void> => {
    if (drained || stepEndsDone >= finishStepsWritten) return Promise.resolve()
    return new Promise<void>((resolve) => {
      wakeBarrier = resolve
    })
  }
  const checkBarrier = () => {
    if (drained || stepEndsDone >= finishStepsWritten) {
      const wake = wakeBarrier
      wakeBarrier = undefined
      wake?.()
    }
  }

  let resolveMessageId!: (id: string) => void
  const messageId = new Promise<string>((resolve) => {
    resolveMessageId = resolve
  })
  let resolveResult!: (result: TurnResult<UIMessage>) => void
  const result = new Promise<TurnResult<UIMessage>>((resolve) => {
    resolveResult = resolve
  })

  const info: TurnInfo = {
    id: turnId,
    kind: op.kind,
    queued: op.queued,
    input: undefined,
    options: op.options.options,
    model: op.options.model ?? config.model,
    settings: mergeSettings(config.settings ?? {}, op.options.settings),
    abortSignal: controller.signal,
    addUsage: (value, source) => {
      const options = typeof source === 'object' && source !== null ? source : {}
      const cost =
        typeof options.costUsd === 'number'
          ? options.costUsd
          : options.model === undefined
            ? undefined
            : costOf(config.models, options.model, value)
      addUsage(usage, value, true, cost)
      // priced nested usage reaches the ledger at the next step boundary (spec 12 §4.1 rule 3)
      if (cost !== undefined && turnState.active) ledger?.nested(cost)
    },
  }
  const turnState: TurnState = {
    info,
    step: undefined,
    runtime: { ...(rt.options.runtime ?? {}), ...(op.options.runtime ?? {}) },
    active: true,
    write,
  }
  rt.turn = turnState

  /** Tool calls written to the stream that have no final result yet (toolCallId → open). */
  const openCalls = new Set<string>()
  /** Calls answered with `INTERRUPTED_TURN` chunks at the end of the turn. */
  const interrupted = new Set<string>()

  function write(chunk: UIMessageChunk): void {
    if (!turnState.active) return
    if (writer === undefined) {
      // the stream is created at `start`: a continuation needs the patched message A' first
      if (chunk.type !== 'start') {
        preStart.push(chunk)
        return
      }
      openStream()
      emit(chunk)
      for (const early of preStart.splice(0)) emit(early)
      return
    }
    emit(chunk)
  }

  /**
   * The terminal `finish` / `abort` chunk of the turn stream: AI SDK gets it now (its `onEnd` runs
   * the end sequence), readers of `run.stream` only after the end sequence completed, so the end
   * of the stream implies the session is free (spec 05 §3 step 17).
   */
  let terminal: UIMessageChunk | undefined

  function emit(chunk: UIMessageChunk): void {
    if (chunk.type === 'finish' || chunk.type === 'abort') {
      terminal ??= chunk
      writer?.write(chunk)
      return
    }
    buffer.push(chunk)
    if (chunk.type === 'finish-step') finishStepsWritten++
    trackToolCall(chunk)
    writer?.write(chunk)
  }

  function trackToolCall(chunk: UIMessageChunk): void {
    switch (chunk.type) {
      case 'tool-input-start':
      case 'tool-input-available':
        openCalls.add(chunk.toolCallId)
        break
      case 'tool-output-available':
        if (chunk.preliminary !== true) openCalls.delete(chunk.toolCallId)
        break
      case 'tool-output-error':
      case 'tool-output-denied':
      case 'tool-input-error':
        openCalls.delete(chunk.toolCallId)
        break
    }
  }

  /**
   * Answer every open tool call that is not pending with an `INTERRUPTED_TURN` error chunk, so
   * the live UI and the stored message agree (spec 05 §3 step 16, ADR-0014).
   */
  function answerOpenCalls(): void {
    if (!committed) return
    const pending = outcome.stop === 'tool-pending' ? outcome.pending : undefined
    for (const toolCallId of [...openCalls]) {
      if (pending !== undefined && pendingCallIds(pending).has(toolCallId)) continue
      interrupted.add(toolCallId)
      write({ type: 'tool-output-error', toolCallId, errorText: INTERRUPTED_TURN })
    }
  }

  /** `start`; a continuation writes it without metadata (A's createdAt/turnId are kept). */
  function writeStart(id: string, parentId: string | null | undefined, metadata = true): void {
    startWritten = true
    write(
      metadata
        ? {
            type: 'start',
            messageId: id,
            messageMetadata: {
              eharness: withoutUndefined({ v: 1, createdAt: startedAt, turnId, parentId }),
            },
          }
        : { type: 'start', messageId: id },
    )
    resolveMessageId(id)
  }

  function usageMeta(): HarnessUsageMeta {
    const meta: HarnessUsageMeta = {
      inputTokens: usage.input + usage.nestedInput,
      outputTokens: usage.output + usage.nestedOutput,
      totalTokens: usage.total + usage.nestedTotal,
    }
    if (usage.reasoning > 0) meta.reasoningTokens = usage.reasoning
    if (usage.cacheRead !== undefined) meta.cachedInputTokens = usage.cacheRead
    if (usage.cacheWrite !== undefined) meta.cacheWriteTokens = usage.cacheWrite
    if (usage.nestedTotal > 0) meta.nested = usage.nestedTotal
    if (usage.costUsd !== undefined) meta.costUsd = usage.costUsd
    return meta
  }

  /** Usage and steps are cumulative over all turns that wrote the message (spec 04 §2). */
  function cumulativeUsage(): HarnessUsageMeta {
    const current = usageMeta()
    const previous = baseMessage?.metadata?.eharness?.usage
    if (previous === undefined) return current
    const out: Record<string, number> = {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      const a = (previous as Record<string, unknown>)[key]
      const b = (current as Record<string, unknown>)[key]
      out[key] = (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0)
    }
    return out as HarnessUsageMeta
  }

  /** The valid final answer of the turn (spec 05 §3.3): only with stop `'complete'`. */
  function validOutput(): { value: unknown } | undefined {
    return outcome.stop === 'complete' ? turnOutput?.state.value : undefined
  }

  /** `metadata.eharness.output` of a turn with `SendOptions.output`. */
  function outputMeta(): { ok: boolean; attempts: number } | undefined {
    if (turnOutput === undefined) return undefined
    const ok = validOutput() !== undefined
    return { ok, attempts: turnOutput.state.failures + (ok ? 1 : 0) }
  }

  /** Interrupted calls + message-metadata + setOutcome + finish | abort (spec 04 §2). */
  function writeEnd(): void {
    if (!startWritten)
      writeStart(assistantId ?? rt.agent.generateId(), undefined, plan === undefined)
    answerOpenCalls()
    const previousSteps = baseMessage?.metadata?.eharness?.steps ?? 0
    const eharness: Record<string, unknown> = committed
      ? withoutUndefined({
          model: describeModel(outcome.model),
          usage: cumulativeUsage(),
          stop: outcome.stop,
          steps: previousSteps + outcome.steps,
          durationMs: Date.now() - startedAt,
          // a continuation resolved A's pending state: null, not absent (metadata is deep-merged)
          pending: plan === undefined ? outcome.pending : (outcome.pending ?? null),
          error: metaError(outcome.error),
          output: outputMeta(),
        })
      : withoutUndefined({ stop: outcome.stop, error: metaError(outcome.error) })
    write({ type: 'message-metadata', messageMetadata: { eharness } })
    const aborted = outcome.stop === 'aborted' || outcome.stop === 'timeout'
    writer?.setOutcome(
      aborted
        ? { status: 'aborted' }
        : outcome.stop === 'error'
          ? { status: 'failed', error: outcome.error }
          : { status: 'completed' },
    )
    write(
      aborted
        ? {
            type: 'abort',
            reason: outcome.abortReason ?? (outcome.stop === 'timeout' ? 'timeout' : 'aborted'),
          }
        : { type: 'finish' },
    )
  }

  // ─── plugin state set by this turn before its commit point ───────────────────────────────
  /** Plugin keys set by this turn's preparation hooks (reverted when it ends before committing). */
  const touched = new Map<string, { plugin: string; key: string }>()
  /** Owners whose preparation hook (or tool source / instruction) is running, with a count. */
  const preparing = new Map<string, number>()
  const stopObserving = rt.state.observe((plugin, key) => {
    if (!committed && preparing.has(plugin)) touched.set(`${plugin}\u0000${key}`, { plugin, key })
  })
  /**
   * Run `fn` as preparation work of `owner`: its `ctx.state` changes are discarded if the turn
   * ends before the commit point; foreign changes (other plugins, core state such as
   * `clearGrants()`) are kept (spec 05 §3).
   */
  async function asOwner<T>(owners: readonly string[], fn: () => Promise<T>): Promise<T> {
    for (const owner of owners) preparing.set(owner, (preparing.get(owner) ?? 0) + 1)
    try {
      return await fn()
    } finally {
      for (const owner of owners) {
        const n = (preparing.get(owner) ?? 1) - 1
        if (n <= 0) preparing.delete(owner)
        else preparing.set(owner, n)
      }
    }
  }

  function earlyEnd(stop: StopReason, error?: unknown): void {
    if (!committed && stateCheckpoint !== undefined)
      rt.state.revert(stateCheckpoint, [...touched.values()])
    if (!startWritten) writeStart(rt.agent.generateId(), undefined) // throwaway id, never stored
    outcome = { stop, steps: 0, model: info.model }
    if (stop === 'aborted' || stop === 'timeout') {
      outcome.stop = timedOut ? 'timeout' : 'aborted'
      outcome.abortReason = timedOut ? 'timeout' : abortReason()
    }
    if (error !== undefined) {
      outcome.error = toTurnError(error, log)
      write({ type: 'error', errorText: outcome.error.message })
    }
    writeEnd()
  }

  function abortReason(): string {
    const reason = controller.signal.reason
    if (typeof reason === 'string') return reason
    if (reason instanceof Error && reason.message.length > 0) return reason.message
    return 'aborted'
  }

  /** Heartbeat (spec 05 §9) and abort poll (§9.1): step ends and the heartbeat timer. */
  async function heartbeat(): Promise<void> {
    await abortPoll?.poll()
    if (!recovery || !committed || assistantId === undefined) return
    if (Date.now() - rt.state.lastWriteAt < staleMs / 4) return
    const active = rt.state.core().activeTurn
    if (active?.turnId !== turnId) return
    active.heartbeatAt = Date.now()
    rt.state.markDirty()
    try {
      await rt.state.write()
    } catch (error) {
      rt.log.warn('eharness: heartbeat state write failed', { error })
    }
  }

  // ─── preparation (spec 05 §3 steps 1–10): nothing is persisted ────────────────────────────
  type Prepared =
    | { kind: 'aborted' }
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

  async function prepare(): Promise<Prepared> {
    // 1. lock + open
    const lock = rt.options.lock
    if (lock !== undefined) {
      try {
        releaseLock = await lock.acquire(rt.id, { signal: controller.signal })
      } catch (error) {
        throw new HarnessError('EH_SESSION_BUSY', 'The session is locked by another instance.', {
          cause: error,
        })
      }
    }
    const open = await host.ensureOpen()
    if (controller.signal.aborted) return { kind: 'aborted' }

    // 2. load context / validate the hot cache; respond() re-reads the state (freshest pending)
    await host.ensureContext()
    if (op.kind === 'respond' && !rt.state.dirty) await rt.state.load()
    else if (rt.state.core().pending !== undefined && !rt.state.dirty) {
      // the cache says "pending": another instance may have resolved it meanwhile (external
      // waits, spec 11 §4.2) — and patched the pending message, which keeps its id, so the
      // `lastId` check above cannot see it: reload the state, and the messages when it changed
      const before = rt.state.core().pending?.messageId
      await rt.state.load()
      if (rt.state.core().pending?.messageId !== before) {
        rt.view = undefined
        await host.ensureContext()
      }
    }
    // hooks of the preparation may change ctx.state: discarded if the turn ends before committing
    stateCheckpoint = rt.state.checkpoint()

    // 3. active-turn check (spec 05 §9)
    let stale: ActiveTurn | undefined
    const active = rt.state.core().activeTurn
    if (recovery && active !== undefined && active.turnId !== turnId) {
      const isStale =
        active.owner === rt.owner ||
        releaseLock !== undefined ||
        Date.now() - active.heartbeatAt > staleMs
      if (!isStale) {
        throw new HarnessError(
          'EH_SESSION_BUSY',
          'A turn of this session is running in another instance.',
          { details: { turnId: active.turnId, owner: active.owner } },
        )
      }
      stale = active
    }

    // 4. operation checks (spec 11 §4, §4.1, §5)
    const core = rt.state.core()
    const view = rt.view ?? []
    if (op.kind === 'respond') {
      plan = planRespond({
        pending: core.pending,
        response: op.respond?.response ?? {},
        view,
        ignoreUnknown: op.respond?.ignoreUnknown === true,
      })
    } else if (core.pending !== undefined) {
      if (config.approval?.onNewInput === 'reject') {
        throw new HarnessError(
          'EH_PENDING_RESPONSE',
          'Tool approvals or client tool calls are waiting; call respond() first.',
          { details: { messageId: core.pending.messageId } },
        )
      }
      denyPending = core.pending
    }
    let target: RewindTarget | undefined
    if (op.kind === 'regenerate' || op.kind === 'edit') {
      target = resolveRewindTarget({
        view,
        registry: rt.agent.messages,
        role: op.kind === 'edit' ? 'user' : 'assistant',
        messageId: op.target,
      })
    }
    /** Generate the rewind id first (id order: rewind < notices < user < assistant). */
    const makeRewind = () => {
      if (target === undefined) return
      rewind = createRewind({
        id: rt.nextId(),
        afterId: target.afterId,
        reason: op.kind === 'edit' ? 'edit' : 'regenerate',
        turnId,
        createdAt: startedAt,
        parentId: target.afterId,
      })
    }

    // 5. options and per-turn settings
    if (config.callOptions !== undefined) {
      info.options = await validateWith(
        config.callOptions,
        op.options.options,
        'SendOptions.options',
      )
    }
    const timeout = info.settings.timeout
    if (typeof timeout === 'object' && timeout !== null && 'totalMs' in timeout) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        '`settings.timeout.totalMs` is not supported (one streamText call per step); use `loop.turnTimeoutMs`.',
      )
    }

    // 6. resolve dynamic sources → TurnRegistry; then validate toolsContext (5) against the
    //    contextSchemas of the resolved tool set (dynamic tools are known only now)
    const sourceOwners = [
      ...open.toolSources.map((s) => s.owner),
      ...open.instructions.filter((i) => i.kind !== 'static').map((i) => i.owner),
    ]
    const resolved = await asOwner(sourceOwners, () =>
      resolveTurnRegistry({
        open,
        approval: config.approval,
        toolOutput: config.toolOutput,
        toolErrorText: config.toolErrorText,
        contextOf: rt.contextOf,
        warn: rt.warn,
        status: (tool) =>
          write({ type: 'data-eh.status', data: { state: 'tool', tool }, transient: true }),
        grants: { current: currentGrants },
      }),
    )
    // structured output (spec 05 §3.3 rule 1): validate the spec; tool mode appends its tool last
    turnOutput = await prepareTurnOutput(op.options.output, new Set(Object.keys(resolved.tools)))
    const registry = withOutputTool(resolved, turnOutput)
    const toolsContext =
      rt.options.toolsContext === undefined && op.options.toolsContext === undefined
        ? undefined
        : { ...(rt.options.toolsContext ?? {}), ...(op.options.toolsContext ?? {}) }
    for (const entry of registry.entries) {
      const schema = entry.tool.contextSchema
      if (schema === undefined) continue
      await validateWith(schema, toolsContext?.[entry.name], `toolsContext of tool '${entry.name}'`)
    }

    // 7. normalize input
    let normalized: NormalizedInput | undefined = op.submitted?.input ?? op.normalized
    if (normalized === undefined && op.input !== undefined) {
      normalized = normalizeInput(op.input, {
        acceptClientMetadata: rt.options.acceptClientMetadata === true,
        files: config.inputFiles,
      })
    }
    if (op.kind === 'edit' && normalized === undefined) {
      throw new HarnessError('EH_INVALID_INPUT', 'edit() needs the replacement input.')
    }
    if (normalized !== undefined && target !== undefined && op.kind === 'edit') {
      // the replaced message's client id is carried over so the UI can reconcile (spec 11 §5)
      normalized = {
        ...normalized,
        clientId: target.message.metadata?.eharness?.clientId ?? target.message.id,
      }
    }

    // 8. input.submit (chainable, fail closed)
    let contexts: string[] = op.submitted?.contexts ?? []
    if (normalized !== undefined && op.submitted === undefined) {
      const submitted = await inputSubmit(
        normalized,
        op.via ?? (op.kind === 'edit' ? 'edit' : 'send'),
      )
      if ('block' in submitted) {
        if (submitted.block.persist !== true)
          return { kind: 'blocked', reason: submitted.block.reason }
        const floor = target === undefined ? (rt.view?.at(-1)?.id ?? null) : target.afterId
        makeRewind()
        const recoveryNoticeId = stale === undefined ? undefined : rt.nextId()
        const user = withInboxMeta(
          buildUserMessage(submitted.input, {
            id: rt.nextId(),
            turnId,
            createdAt: startedAt,
            parentId: floor,
          }),
        )
        info.input = user
        const blockNotice = createKindMessage(
          'eh.notice',
          { level: 'warning', code: 'EH_INPUT_BLOCKED', message: submitted.block.reason },
          { id: rt.nextId(), turnId, createdAt: Date.now(), parentId: user.id },
        )
        writeStart(rt.agent.generateId(), undefined) // no assistant message for a block
        return {
          kind: 'turn',
          open,
          registry: undefined,
          stale,
          user,
          blockNotice,
          recoveryNoticeId,
          toolsContext: undefined,
          activeTools: undefined,
        }
      }
      normalized = submitted.input
      contexts = submitted.contexts
    }

    // 9. turn.prepare (chainable)
    let activeTools: string[] | undefined
    for (const hook of open.hooks.list('turn.prepare')) {
      try {
        const out = await asOwner([hook.owner], async () =>
          hook.fn(rt.contextOf(hook.owner), {
            model: info.model,
            settings: info.settings,
            options: info.options,
          }),
        )
        if (out === undefined || out === null) continue
        if (out.model !== undefined) info.model = out.model
        if (out.settings !== undefined) info.settings = mergeSettings(info.settings, out.settings)
        if (out.activeTools !== undefined) {
          const allowed = new Set(out.activeTools)
          activeTools =
            activeTools === undefined
              ? [...out.activeTools]
              : activeTools.filter((name) => allowed.has(name))
        }
      } catch (error) {
        hookFailed(rt, 'turn.prepare', hook.owner, error)
      }
    }
    if (controller.signal.aborted) return { kind: 'aborted' }

    // 10. ids with the floor: rewind < recovery notice < user < assistant; then `start` (a
    //     continuation keeps A's id and writes `start` after the commit point, with A')
    const newest = target === undefined ? (rt.view?.at(-1)?.id ?? null) : target.afterId
    makeRewind()
    const recoveryNoticeId = stale === undefined ? undefined : rt.nextId()
    let user: HarnessUIMessage | undefined
    if (normalized !== undefined) {
      user = withInboxMeta(
        buildUserMessage(
          contexts.length === 0
            ? normalized
            : {
                ...normalized,
                parts: [
                  ...normalized.parts,
                  ...contexts.map((text) => ({ type: 'text' as const, text })),
                ],
              },
          {
            id: rt.nextId(),
            turnId,
            createdAt: startedAt,
            parentId: newest,
            augmented: contexts.length,
          },
        ),
      )
      info.input = user
    }
    if (plan !== undefined) {
      assistantId = plan.pending.messageId
    } else {
      assistantId = rt.nextId()
      writeStart(assistantId, user?.id ?? newest)
    }
    return {
      kind: 'turn',
      open,
      registry,
      stale,
      user,
      blockNotice: undefined,
      recoveryNoticeId,
      toolsContext,
      activeTools,
    }
  }

  /** `metadata.eharness.inboxId` / `collected` of a user message made from inbox items. */
  function withInboxMeta(user: HarnessUIMessage): HarnessUIMessage {
    const meta = op.inbox?.meta
    const eharness = user.metadata?.eharness
    if (meta === undefined || eharness === undefined) return user
    if ('inboxId' in meta) eharness.inboxId = meta.inboxId
    else eharness.collected = structuredClone(meta.collected)
    return user
  }

  /** Settle the op's inbox items once (ack when applied, else by outcome). */
  function settleOpInbox(how: 'applied' | InboxSettle): void {
    const items = op.inbox
    if (items === undefined || inboxSettled) return
    inboxSettled = true
    if (how === 'applied') host.inboxApplied(items.ids, turnId)
    else host.inboxNotApplied(items.ids, how)
  }

  async function inputSubmit(
    input: NormalizedInput,
    via: 'send' | 'edit' | 'steer' | 'queue',
  ): Promise<
    | { input: NormalizedInput; contexts: string[] }
    | { input: NormalizedInput; block: { reason: string; persist?: boolean } }
  > {
    const open = rt.open
    let current = input
    const contexts: string[] = []
    for (const hook of open?.hooks.list('input.submit') ?? []) {
      const message = buildUserMessage(current, {
        id: current.clientId ?? '',
        turnId,
        createdAt: startedAt,
      })
      let out: Awaited<ReturnType<typeof hook.fn>>
      try {
        out = await asOwner([hook.owner], async () =>
          hook.fn(rt.contextOf(hook.owner), { message, via }),
        )
      } catch (error) {
        return {
          input: current,
          block: { reason: error instanceof Error ? error.message : String(error) },
        }
      }
      if (out === undefined || out === null) continue
      if ('block' in out) return { input: current, block: out.block }
      if ('message' in out) {
        const renormalized = normalizeInput(out.message, {
          acceptClientMetadata: rt.options.acceptClientMetadata === true,
          files: config.inputFiles,
        })
        current = { ...renormalized }
        if (input.clientId === undefined) delete current.clientId
        else current.clientId = input.clientId
      } else if ('context' in out && Array.isArray(out.context)) {
        for (const text of out.context)
          if (typeof text === 'string' && text.length > 0) contexts.push(text)
      }
    }
    return { input: current, contexts }
  }

  // ─── commit point (spec 05 §3 steps 11–12) ────────────────────────────────────────────────
  async function commit(prep: Extract<Prepared, { kind: 'turn' }>): Promise<void> {
    const core = rt.state.core()
    // the core fields this commit changes, as they were: put back if its write fails, so a later
    // writeIfDirty (close, idle eviction) never publishes a turn that did not commit
    const before = {
      activeTurn: structuredClone(core.activeTurn),
      pending: structuredClone(core.pending),
      grants: structuredClone(core.grants),
      rewinds: structuredClone(core.rewinds),
      abortRequest: structuredClone(core.abortRequest),
      inboxDelivered: structuredClone(core.inboxDelivered),
    }
    const undo = () => {
      for (const key of [
        'activeTurn',
        'pending',
        'grants',
        'rewinds',
        'abortRequest',
        'inboxDelivered',
      ] as const) {
        if (before[key] === undefined) delete core[key]
        else (core as Record<string, unknown>)[key] = before[key]
      }
    }
    let needWrite = rt.state.dirty
    // an abort request never names the new turn: it is stale (spec 05 §9.1 rule 6)
    if (core.abortRequest !== undefined) {
      delete core.abortRequest
      needWrite = true
    }
    if (prep.stale !== undefined) {
      delete core.activeTurn
      needWrite = true
    }
    if (recovery && assistantId !== undefined) {
      const now = Date.now()
      core.activeTurn = withoutUndefined({
        turnId,
        kind: op.kind,
        messageId: assistantId,
        userMessageId: prep.user?.id,
        owner: rt.owner,
        startedAt: now,
        heartbeatAt: now,
      })
      needWrite = true
    }
    // consume (respond) or deny (new input) the pending state in the same write (spec 11 §4, §4.1)
    if ((plan !== undefined || denyPending !== undefined) && core.pending !== undefined) {
      delete core.pending
      needWrite = true
    }
    if (plan !== undefined) {
      const remembered = plan.approvals.filter((a) => a.remember === 'session')
      if (remembered.length > 0) {
        grantsBefore = core.grants === undefined ? undefined : { ...core.grants }
        core.grants = { ...(core.grants ?? {}) }
        for (const a of remembered) core.grants[a.toolName] = a.approved ? 'always' : 'never'
        grantsRecorded = true
        needWrite = true
      }
    }
    // inbox items of a send turn: dedupe of redeliveries reads `inboxId` / `collected` of the
    // saved user message; a wake turn records its ids once its effect is saved (onEnd), so
    // nothing about them is written here (spec 05 §12 rule 5)
    if (rewind !== undefined) {
      const payload = rewind.parts[0] as { data: { afterId: string | null } }
      core.rewinds = [
        ...(core.rewinds ?? []),
        { afterId: payload.data.afterId, rewindId: rewind.id },
      ]
      needWrite = true
    }
    if (needWrite) {
      rt.state.markDirty()
      let ok: boolean
      try {
        ok = await rt.state.write({ cas: true })
      } catch (error) {
        undo()
        rt.view = undefined // force a reload of state and messages at the next operation
        throw error
      }
      if (!ok) {
        // another instance owns the stored state now: drop ours (never overwrite theirs later)
        undo()
        stateCheckpoint = undefined // the reloaded state is not ours to revert
        try {
          await rt.state.load()
        } catch {
          rt.state.discard()
        }
        rt.view = undefined
        throw new HarnessError(
          'EH_SESSION_BUSY',
          'The session state was changed by another instance.',
        )
      }
    }
    committed = true
    if (recovery) {
      // owner writes keep a foreign abort request (spec 05 §9.1 rule 4); a merged one aborts
      rt.state.guard(turnId, (request) => abortFromRequest(request.reason))
      if (abortPollMs > 0) {
        abortPoll = createAbortPoll({
          turnId,
          intervalMs: abortPollMs,
          peek: () => rt.state.peek(),
          abort: (request) => abortFromRequest(request.reason),
          done: () => ended || controller.signal.aborted,
          onError: (error) => rt.log.warn('eharness: abort poll state read failed', { error }),
        })
      }
    }
    await reportAnswers(prep.open)

    // crash recovery of a stale turn (spec 05 §9)
    const stale = prep.stale
    if (stale !== undefined) {
      const message = rt.view?.find((m) => m.id === stale.messageId)
      if (message !== undefined) {
        const patched = answerDanglingToolParts(structuredClone(message), INTERRUPTED_CRASH)
        const eharness = patched.metadata?.eharness
        if (eharness?.stop === undefined) {
          patched.metadata = {
            ...(patched.metadata ?? {}),
            eharness: { ...(eharness ?? { v: 1, createdAt: startedAt }), stop: 'interrupted' },
          }
        }
        await host.persist([patched])
      }
      const notice = createKindMessage(
        'eh.notice',
        {
          level: 'warning',
          code: 'EH_TURN_INTERRUPTED',
          message: 'The previous turn was interrupted: its process stopped before it finished.',
        },
        {
          id: prep.recoveryNoticeId ?? rt.nextId(),
          turnId: stale.turnId,
          createdAt: Date.now(),
          parentId: stale.messageId,
        },
      )
      created.push(...(await host.persist([notice])))
      rt.events.emit({
        type: 'turn-end',
        turnId: stale.turnId,
        messageId: stale.messageId,
        stop: 'interrupted',
      })
    }
    await healOrphanPending()
    // the pending message: patched for the continuation (respond) or denied (new input)
    if (plan !== undefined) {
      await continuePending(prep.open, plan)
      // results answered here (not recorded before) resolve their waits now
      for (const e of plan.externals) {
        if (!e.recorded) rt.events.emit({ type: 'wait-resolved', waitId: e.waitId, by: 'result' })
      }
    }
    if (denyPending !== undefined) {
      const pending = denyPending
      const message = rt.view?.find((m) => m.id === pending.messageId)
      if (message !== undefined) await host.persist([patchForNewInput(message, pending)])
      rt.events.emit({ type: 'pending', pending: null })
      for (const e of pending.externals ?? []) {
        if (e.result === undefined) {
          rt.events.emit({ type: 'wait-resolved', waitId: e.waitId, by: 'cancel' })
        }
      }
    }
    if (rewind !== undefined) {
      created.push(...(await host.persist([rewind])))
      const marker = rewind
      const hidden = [{ afterId: afterIdOf(marker), rewindId: marker.id }]
      if (rt.view !== undefined) {
        rt.view = rt.view.filter((m) => !hiddenByRewind(m, hidden, rt.agent.messages))
      }
    }
    if (prep.user !== undefined) created.push(...(await host.persist([prep.user])))
    if (prep.blockNotice !== undefined) created.push(...(await host.persist([prep.blockNotice])))
    createdBeforeAssistant = created.length
    // the user message is durable: the inbox items are applied (a durable wake: at the end)
    if (!wakeFromInbox) settleOpInbox('applied')
  }

  /**
   * A message still marked pending (`metadata.eharness.pending`) although `state.core.pending` no
   * longer names it: a process died between the state write that consumed / denied the pending
   * state and the save of the patched message. Its calls never ran: answer them with
   * `INTERRUPTED_CRASH` and mark the message resolved (spec 05 §9, spec 11 §8).
   */
  async function healOrphanPending(): Promise<void> {
    const handled = new Set<string | undefined>([
      plan?.pending.messageId,
      denyPending?.messageId,
      rt.state.core().pending?.messageId,
    ])
    const orphans = (rt.view ?? []).filter((m) => {
      const pending = m.metadata?.eharness?.pending
      return (
        m.role === 'assistant' && pending !== undefined && pending !== null && !handled.has(m.id)
      )
    })
    for (const message of orphans) {
      const patched = answerDanglingToolParts(structuredClone(message), INTERRUPTED_CRASH)
      const eharness = patched.metadata?.eharness
      if (eharness === undefined) continue
      const stop =
        eharness.stop === undefined || eharness.stop === 'tool-pending'
          ? 'interrupted'
          : eharness.stop
      await host.persist([
        {
          ...patched,
          metadata: { ...patched.metadata, eharness: { ...eharness, pending: null, stop } },
        },
      ])
    }
  }

  function afterIdOf(marker: HarnessUIMessage): string | null {
    return (marker.parts[0] as { data: { afterId: string | null } }).data.afterId
  }

  /**
   * Build and save A' (spec 11 §4 step 3): client tool outputs pass through `tool.after` and the
   * output limits (spec 09 §6), then approval / client parts are patched and `pending` set to
   * null. A' becomes the stream's `originalMessages` (the continuation streams into it).
   */
  /** `approval.decided` for respond() answers and new-input denials (spec 11 §3.3), after commit. */
  async function reportAnswers(open: OpenSession): Promise<void> {
    const deps = { hooks: open.hooks, contextOf: rt.contextOf, warn: rt.warn }
    if (open.hooks.list('approval.decided').length === 0) return
    const pendingOf = (pending: PendingState | undefined, id: string) =>
      pending?.approvals.find((a) => a.approvalId === id)
    for (const answer of plan?.approvals ?? []) {
      const entry = pendingOf(plan?.pending, answer.approvalId)
      await reportDecision(
        deps,
        withoutUndefined({
          toolName: answer.toolName,
          toolCallId: answer.toolCallId,
          input: entry?.input,
          risk: entry?.risk,
          idempotent: entry?.idempotent,
          approved: answer.approved,
          by: 'user' as const,
          reason: answer.reason,
          actor: answer.actor,
          approvalId: answer.approvalId,
          remember: answer.remember,
        }),
      )
    }
    for (const entry of denyPending?.approvals ?? []) {
      await reportDecision(
        deps,
        withoutUndefined({
          toolName: entry.toolName,
          toolCallId: entry.toolCallId,
          input: entry.input,
          risk: entry.risk,
          idempotent: entry.idempotent,
          approved: false,
          by: 'new-input' as const,
          reason: DENIED_NEW_INPUT,
          approvalId: entry.approvalId,
        }),
      )
    }
  }

  async function continuePending(open: OpenSession, answers: RespondPlan): Promise<void> {
    const message = rt.view?.find((m) => m.id === answers.pending.messageId)
    if (message === undefined) {
      throw new HarnessError('EH_INVALID_INPUT', 'The pending message is no longer stored.', {
        details: { reason: 'stale', messageId: answers.pending.messageId },
      })
    }
    // if anything below fails, the turn still ends on A (its answered calls become interrupted)
    baseMessage = structuredClone(message)
    original = [baseMessage as UIMessage]
    rt.events.emit({ type: 'pending', pending: null })
    const deps = {
      hooks: open.hooks,
      contextOf: rt.contextOf,
      warn: rt.warn,
      status: () => {},
      limits: {
        config: config.toolOutput,
        toolOutputs: open.services.get('toolOutputs') as ToolOutputSink | undefined,
      },
    }
    clientOutputs = []
    for (const answer of answers.toolOutputs) {
      // errors and recorded external results (already through tool.after / limits) are final
      if ('errorText' in answer || answer.finished === true) {
        clientOutputs.push(answer)
        continue
      }
      const part = message.parts.find(
        (p) => (p as { toolCallId?: string }).toolCallId === answer.toolCallId,
      ) as { input?: unknown } | undefined
      const output = await finishToolOutput(
        answer.toolName,
        answer.toolCallId,
        part?.input,
        answer.output,
        deps,
      )
      clientOutputs.push({ ...answer, output })
    }
    const patched = patchForRespond(message, answers.approvals, clientOutputs)
    baseMessage = patched
    original = [patched as UIMessage]
    const [saved] = await host.persist([patched])
    if (saved !== undefined) {
      baseMessage = saved
      original = [saved as UIMessage]
    }
  }

  // ─── execute ──────────────────────────────────────────────────────────────────────────────
  async function body(): Promise<void> {
    let prep: Prepared
    try {
      prep = await prepare()
    } catch (error) {
      earlyEnd('error', error)
      return
    }
    if (prep.kind === 'aborted') return earlyEnd('aborted')
    if (prep.kind === 'blocked') return earlyEnd('blocked')

    try {
      await commit(prep)
    } catch (error) {
      if (!committed) return earlyEnd('error', error)
      // committed but not applied: the items are tried again (dedupe skips a saved user message)
      if (op.inbox !== undefined && !inboxSettled) settleOpInbox({ how: 'retry', error })
      if (!startWritten)
        writeStart(assistantId ?? rt.agent.generateId(), undefined, plan === undefined)
      outcome = { stop: 'error', steps: 0, model: info.model, error: toTurnError(error, log) }
      write({ type: 'error', errorText: outcome.error?.message ?? '' })
      return writeEnd()
    }
    if (plan !== undefined) {
      // continuation: stream into A' (spec 04 §2); client outputs first, approved calls are open
      writeStart(plan.pending.messageId, undefined, false)
      for (const answer of clientOutputs) {
        write(
          'errorText' in answer
            ? {
                type: 'tool-output-error',
                toolCallId: answer.toolCallId,
                errorText: answer.errorText,
              }
            : {
                type: 'tool-output-available',
                toolCallId: answer.toolCallId,
                output: answer.output,
              },
        )
      }
      for (const answer of plan.approvals) openCalls.add(answer.toolCallId)
    }
    if (prep.blockNotice !== undefined) {
      outcome = { stop: 'blocked', steps: 0, model: info.model }
      return writeEnd()
    }
    rt.events.emit({
      type: 'turn-start',
      turnId,
      messageId: assistantId ?? '',
      kind: op.kind,
      queued: op.queued,
    })
    if (recovery) {
      const tick = abortPollMs > 0 ? Math.min(staleMs / 4, abortPollMs) : staleMs / 4
      heartbeatTimer = setInterval(() => void heartbeat(), Math.max(1, tick))
      unref(heartbeatTimer)
    }

    const open = prep.open
    for (const hook of open.hooks.list('turn.start')) {
      try {
        await hook.fn(rt.contextOf(hook.owner), { kind: op.kind, input: info.input })
      } catch (error) {
        hookFailed(rt, 'turn.start', hook.owner, error)
      }
    }
    const registry = prep.registry as TurnRegistry
    try {
      const view = rt.view ?? []
      const messageId = assistantId as string
      const compaction = createTurnCompaction({
        engine: host.compaction,
        rt,
        turnId,
        assistantId: messageId,
        currentStartId: currentTurnStartId(
          view,
          op.kind === 'respond'
            ? { kind: 'respond', messageId }
            : op.kind === 'regenerate'
              ? { kind: 'regenerate', assistantId: messageId }
              : prep.user === undefined
                ? { kind: 'no-input', assistantId: messageId }
                : { kind: 'input', userMessageId: prep.user.id },
          rt.agent.messages,
        ),
        info,
        registry,
        write,
        signal: controller.signal,
        pending: null,
        // A' is cached: its approval-responded parts project to the trailing approval message
        ...(op.kind === 'respond' ? { continuing: messageId } : {}),
        inboxed,
        // summarizer usage is turn usage: counted in TurnResult.usage, cost and budgets
        toolsContext: prep.toolsContext,
        onUsage: (value, model, source) => {
          if (config.budget !== undefined && costOf(config.models, model, value) === undefined) {
            rt.warn(
              {
                code: 'W_MODEL_UNPRICED',
                message: `No pricing for model '${describeModel(model)}' in \`models\`; its usage does not count toward the budget.`,
                details: { model: describeModel(model) },
              },
              `unpriced:${describeModel(model)}`,
            )
          }
          info.addUsage(value, { model, source })
        },
        overBudget: () =>
          budgetOverrun(config.budget, usage.costUsd ?? 0, rt.state.core().usage?.costUsd ?? 0),
      })
      // pre-turn compaction check (spec 05 §3 step 14, spec 06 §4)
      const built = await compaction.preTurn(await compaction.build())
      const wire: ModelMessage[] = built.wire
      const result: LoopResult = await runSteps({
        rt,
        registry,
        info,
        wire,
        turnStart: built.turnStart,
        messageId,
        activeTools: prep.activeTools,
        maxSteps: op.options.maxSteps ?? config.loop?.maxSteps ?? DEFAULT_MAX_STEPS,
        maxContinues: config.loop?.maxContinues ?? Number.POSITIVE_INFINITY,
        maxIdleContinues: config.loop?.maxIdleContinues ?? DEFAULT_MAX_IDLE_CONTINUES,
        maxOutputTokens: config.loop?.maxTurnOutputTokens ?? Number.POSITIVE_INFINITY,
        wrapUp: config.loop?.wrapUp ?? true,
        progress: config.loop?.progress,
        models: config.models,
        budget: config.budget,
        sessionCostBefore: rt.state.core().usage?.costUsd ?? 0,
        ledger,
        toolsContext: prep.toolsContext,
        cache: config.cache,
        signal: controller.signal,
        timedOut: () => timedOut,
        write,
        barrier,
        usage,
        discovered: seedDiscovered(view),
        heartbeat,
        compaction,
        continuation: op.kind === 'respond',
        inbox,
        delivered: (item) => {
          if (item.inboxId !== undefined) {
            // dedupe of a redelivery reads `inboxId` of the saved data-eh.input part (spec 05 §12
            // rule 5): nothing goes to the state before that snapshot is durable
            deliveredSteers.push({
              inboxId: item.inboxId,
              afterFinish: finishStepsWritten,
              done: false,
            })
          }
          if (item.event !== undefined) {
            deliveredEvents.push({
              message: item.event,
              afterFinish: finishStepsWritten,
              done: false,
            })
          }
        },
        ...(turnOutput === undefined ? {} : { output: turnOutput }),
      })
      outcome = withoutUndefined({ ...result }) as Outcome
      const answer = validOutput()
      if (answer !== undefined && turnOutput !== undefined) {
        // the audit record of the answer (persistent, never projected; spec 03 §4.3)
        write({
          type: 'data-eh.output',
          id: 'output',
          data: {
            value: structuredClone(answer.value),
            mode: turnOutput.mode,
            attempts: turnOutput.state.failures + 1,
          },
        })
      }
    } catch (error) {
      outcome = {
        stop: 'error',
        steps: outcome.steps,
        model: info.model,
        error: toTurnError(error, log),
      }
      write({ type: 'error', errorText: outcome.error?.message ?? '' })
    }
    // release an open reservation, record the last nested usage (spec 12 §4.1); never throws
    await ledger?.end()
    writeEnd()
  }

  // ─── end sequence (spec 05 §3 step 17) ────────────────────────────────────────────────────
  let ended = false
  let lastStepMessage: HarnessUIMessage | undefined

  async function onStepEnd(message: HarnessUIMessage): Promise<void> {
    try {
      if (committed && assistantId !== undefined && message.id === assistantId) {
        lastStepMessage = message
        rt.cacheMessage(message)
        if (config.loop?.persistEachStep !== false) {
          let saved = false
          try {
            await host.persist([structuredClone(message)])
            saved = true
          } catch (error) {
            // retried by the next step's (or the final) save
            rt.log.warn('eharness: assistant snapshot save failed; retrying at the next step', {
              error,
            })
          }
          // events delivered before this finish-step are in the saved snapshot now
          if (saved) await markDelivered(stepEndsDone + 1)
        }
      }
    } finally {
      stepEndsDone++
      checkBarrier()
    }
  }

  /**
   * Set `deliveredIn` on kind messages delivered as `data-eh.input` whose part is in the saved
   * snapshot of finish-step `upTo` (spec 11 §6.3: at-least-once, never zero times).
   */
  async function markDelivered(upTo: number): Promise<void> {
    // inbox steers in the saved snapshot are applied (spec 05 §12 rule 5)
    const steers: string[] = []
    for (const entry of deliveredSteers) {
      if (entry.done || entry.afterFinish >= upTo) continue
      entry.done = true
      steers.push(entry.inboxId)
    }
    if (steers.length > 0) host.inboxApplied(steers, turnId)
    for (const entry of deliveredEvents) {
      if (entry.done || entry.afterFinish >= upTo || assistantId === undefined) continue
      entry.done = true
      const eharness = entry.message.metadata?.eharness
      const updated: HarnessUIMessage = {
        ...entry.message,
        metadata: {
          ...entry.message.metadata,
          eharness: { ...(eharness ?? { v: 1, createdAt: startedAt }), deliveredIn: assistantId },
        },
      }
      try {
        await host.persist([updated])
      } catch (error) {
        entry.done = false
        rt.log.warn('eharness: marking a delivered event failed; it may be projected again', {
          error,
        })
      }
    }
  }

  /** Undelivered steers: queued `send` turns, or `input-dropped` for tool-pending / aborts. */
  async function settleInbox(stop: StopReason): Promise<void> {
    const leftovers = await inbox.close()
    let wake = false
    for (const item of leftovers) {
      const steer = item.steer
      if (steer === undefined) {
        // an undelivered event stays for the next turn; a wake starts that turn (not after aborts)
        if (item.wake === true && stop !== 'aborted' && stop !== 'timeout') wake = true
        continue
      }
      if (stop === 'tool-pending' || stop === 'aborted' || stop === 'timeout') {
        rt.events.emit(
          withoutUndefined({
            type: 'input-dropped' as const,
            reason: stop === 'tool-pending' ? ('tool-pending' as const) : ('aborted' as const),
            text: steer.text,
            clientId: steer.input.clientId,
          }),
        )
        // a closing session hands a durable steer to the next holder; otherwise it is dropped
        if (item.inboxId !== undefined) {
          host.inboxNotApplied([item.inboxId], rt.closed ? { how: 'defer' } : { how: 'drop' })
        }
      } else {
        // a durable steer is released before the session's end-of-turn drain runs
        await host.enqueueSteer({ input: steer.input, contexts: steer.contexts }, item.inboxId)
      }
    }
    if (wake) host.enqueueWake()
  }

  async function onEnd(message: HarnessUIMessage | undefined): Promise<void> {
    if (ended) return
    ended = true
    if (turnTimer !== undefined) clearTimeout(turnTimer)
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    external?.removeEventListener('abort', onExternalAbort)
    let stop = outcome.stop
    let error = outcome.error
    let assistant: HarnessUIMessage | undefined
    const after: HarnessUIMessage[] = []
    if (committed) {
      if (assistantId !== undefined) {
        let final = structuredClone(
          message ??
            lastStepMessage ??
            baseMessage ?? {
              id: assistantId,
              role: 'assistant' as const,
              metadata: { eharness: { v: 1 as const, createdAt: startedAt, turnId } },
              parts: [],
            },
        )
        final.id = assistantId
        const pending = outcome.pending
        final = answerDanglingToolParts(final, INTERRUPTED_TURN, (part) =>
          pending === undefined ? false : pendingCallIds(pending).has(part.toolCallId),
        )
        // chunk-answered parts: same shape as answerDanglingToolParts (input {} fallback, no approval)
        final = {
          ...final,
          parts: final.parts.map((part) => {
            const tool = part as { toolCallId?: string; input?: unknown; approval?: unknown }
            if (tool.toolCallId === undefined || !interrupted.has(tool.toolCallId)) return part
            const { approval: _approval, ...rest } = tool
            return { ...rest, input: tool.input ?? {} } as typeof part
          }),
        }
        assistant = final
        try {
          assistant = (await host.persist([final]))[0] ?? final
          await markDelivered(Number.POSITIVE_INFINITY)
        } catch (saveError) {
          stop = 'error'
          error = toTurnError(saveError, log)
          rt.cacheMessage(final)
        }
        if (
          outcome.stop === 'error' ||
          outcome.stop === 'timeout' ||
          outcome.stop === 'context-thrash'
        ) {
          const notice = createKindMessage(
            'eh.notice',
            outcome.stop === 'timeout'
              ? {
                  level: 'warning',
                  code: 'EH_TURN_TIMEOUT',
                  message: 'The turn exceeded its time limit.',
                }
              : outcome.stop === 'context-thrash'
                ? {
                    level: 'warning',
                    code: 'EH_CONTEXT_THRASH',
                    message:
                      'The turn stopped: its context filled up again right after a compaction.',
                  }
                : withoutUndefined({
                    level: 'error' as const,
                    code: outcome.error?.code,
                    message: outcome.error?.message ?? 'The turn failed.',
                  }),
            { id: rt.nextId(), turnId, createdAt: Date.now(), parentId: assistantId },
          )
          try {
            after.push(...(await host.persist([notice])))
          } catch (noticeError) {
            rt.log.warn('eharness: saving the error notice failed', { error: noticeError })
          }
        }
      }
      const core = rt.state.core()
      const parked = stop === 'tool-pending' ? outcome.pending : undefined
      if (parked !== undefined) {
        core.pending = parked
        rt.state.markDirty()
        rt.events.emit({ type: 'pending', pending: parked })
      }
      if (core.activeTurn?.turnId === turnId) {
        delete core.activeTurn
        rt.state.markDirty()
      }
      if (core.abortRequest !== undefined) {
        delete core.abortRequest // served (or stale): cleared by the end-of-turn write
        rt.state.markDirty()
      }
      const previous = core.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
      core.usage = {
        inputTokens: previous.inputTokens + usage.input + usage.nestedInput,
        outputTokens: previous.outputTokens + usage.output + usage.nestedOutput,
        turns: previous.turns + (outcome.steps > 0 ? 1 : 0),
      }
      const cost = (previous.costUsd ?? 0) + (usage.costUsd ?? 0)
      if (previous.costUsd !== undefined || usage.costUsd !== undefined) core.usage.costUsd = cost
      rt.state.markDirty()
      // a durable wake turn: its ids are written with this state write (dedupe), acked after it
      const wakeIds = wakeFromInbox && !inboxSettled ? (op.inbox?.ids ?? []) : []
      if (wakeIds.length > 0) recordDelivered(core, wakeIds)
      let stateSaved = false
      try {
        stateSaved = await rt.state.writeIfDirty()
        if (!stateSaved) await lostState()
      } catch (stateError) {
        rt.log.warn('eharness: end-of-turn state write failed', { error: stateError })
      }
      // external waits with a timeout: a durable timer item and the live timer (spec 11 §4.2 rule 6)
      if (stateSaved && parked?.externals !== undefined) {
        await host.waitsParked(parked)
        // what `start` returned is stored with the pending state: the result carries it too
        const settled = rt.state.core().pending
        if (settled?.messageId === parked.messageId) outcome.pending = structuredClone(settled)
      }
      if (wakeIds.length > 0) {
        if (stateSaved) settleOpInbox('applied')
        else {
          forgetDelivered(rt.state.core(), wakeIds)
          settleOpInbox({ how: 'retry', error: new Error('end-of-turn state write failed') })
        }
      }
    }
    rt.state.guard(undefined)
    if (op.inbox !== undefined && !inboxSettled) {
      // not applied: retried elsewhere when another instance had the session (or ours closes)
      // (with `inbox.retry`: deferral / counted attempt / dead, spec 05 §12 rules 11–13)
      const code = outcome.error?.code
      const failure = outcome.error ?? new Error(`turn ended: ${stop}`)
      if (rt.closed) {
        // dropped by `close()`: not tried unless it got past its commit point
        settleOpInbox(committed ? { how: 'retry', error: failure } : { how: 'defer' })
      } else if (stop === 'error' && (code === 'EH_SESSION_BUSY' || code === 'EH_STORAGE')) {
        settleOpInbox({ how: 'retry', error: failure })
      } else if (stop === 'error') {
        settleOpInbox({ how: 'error', error: failure })
      } else settleOpInbox({ how: 'drop' })
    }

    const messages = [
      ...created.slice(0, createdBeforeAssistant),
      ...(assistant === undefined ? [] : [assistant]),
      ...created.slice(createdBeforeAssistant),
      ...after,
    ]
    const turnResult: TurnResult<UIMessage> = withoutUndefined({
      turnId,
      kind: op.kind,
      messageId: committed ? assistantId : undefined,
      stop,
      pending: stop === 'tool-pending' ? outcome.pending : undefined,
      messages: structuredClone(messages) as UIMessage[],
      usage: withoutUndefined({
        inputTokens: usage.input + usage.nestedInput,
        outputTokens: usage.output + usage.nestedOutput,
        totalTokens: usage.total + usage.nestedTotal,
        cachedInputTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costUsd: usage.costUsd,
      }),
      steps: outcome.steps,
      durationMs: Date.now() - startedAt,
      error: stop === 'error' ? error : undefined,
      output: stop === 'complete' ? validOutput()?.value : undefined,
    })
    if (committed) {
      const endId = assistantId ?? created.at(-1)?.id
      if (endId !== undefined) rt.events.emit({ type: 'turn-end', turnId, messageId: endId, stop })
      for (const hook of rt.open?.hooks.list('turn.end') ?? []) {
        try {
          await hook.fn(rt.contextOf(hook.owner), turnResult as TurnResult)
        } catch (hookError) {
          hookFailed(rt, 'turn.end', hook.owner, hookError)
        }
      }
    }
    await settleInbox(stop)
    if (releaseLock !== undefined) {
      try {
        await releaseLock()
      } catch (lockError) {
        rt.log.warn('eharness: releasing the session lock failed', { error: lockError })
      }
    }
    if (rt.turn === turnState) rt.turn = undefined
    rt.running = false
    rt.events.emit({ type: 'status', running: false })
    resolveResult(turnResult)
    host.onTurnEnd()
    stopObserving()
    // the stream ends last: a reader that saw `finish` can start the next turn right away
    closeBuffer()
  }

  /**
   * The guarded end-of-turn write found the stored state owned by another instance (it recovered
   * this turn as stale): its state wins, ours is reloaded (spec 05 §9.1).
   */
  async function lostState(): Promise<void> {
    rt.log.warn(
      'eharness: end-of-turn state write skipped: another instance owns the session state',
    )
    try {
      await rt.state.load()
    } catch {
      rt.state.discard()
    }
    rt.view = undefined
  }

  /** A matching cross-process abort request (spec 05 §9.1): the normal abort path. */
  function abortFromRequest(reason: string | undefined): void {
    if (ended || controller.signal.aborted) return
    host.dropQueue()
    controller.abort(reason ?? 'aborted')
  }

  function closeBuffer(): void {
    if (terminal !== undefined) buffer.push(terminal)
    buffer.close()
  }

  // ─── the stream ───────────────────────────────────────────────────────────────────────────
  /**
   * Create the AI SDK stream (at `start`, so a continuation can pass `originalMessages: [A']`).
   * `execute` only hands out the writer; the turn runs in `body()` and resolves it at the end.
   */
  function openStream(): void {
    const stream = createUIMessageStream<UIMessage>({
      generateId: () => rt.agent.generateId(),
      ...(original === undefined ? {} : { originalMessages: original }),
      // also receives AI SDK echoes of error chunks already written (and described) by the core
      onError: (error) => describeError(error),
      onStepEnd: ({ responseMessage }) => onStepEnd(responseMessage as HarnessUIMessage),
      onEnd: ({ responseMessage }) => onEnd(responseMessage as HarnessUIMessage),
      execute: ({ writer: w }) => {
        writer = w
        return new Promise<void>((resolve) => {
          finishExecute = resolve
        })
      },
    })

    // the core drains the stream itself, so the turn never stalls and is always persisted even
    // if the caller never reads run.stream (which replays the turn buffer, spec 04 §5)
    void (async () => {
      const reader = stream.getReader()
      try {
        while (!(await reader.read()).done) {
          // drain
        }
      } catch (error) {
        rt.log.error('eharness: turn stream failed', { error })
      } finally {
        drained = true
        checkBarrier()
        // AI SDK skips onEnd when its pipeline fails; the end sequence must still run
        if (!ended) await onEnd(undefined)
      }
    })()
  }

  rt.events.emit({ type: 'status', running: true })
  void (async () => {
    try {
      await body()
    } catch (error) {
      // defensive: body() handles its own errors
      rt.log.error('eharness: unexpected turn failure', { error })
      if (!startWritten) writeStart(rt.agent.generateId(), undefined)
      outcome = {
        stop: 'error',
        steps: outcome.steps,
        model: info.model,
        error: toTurnError(error, log),
      }
      write({ type: 'error', errorText: outcome.error?.message ?? '' })
      writeEnd()
    } finally {
      turnState.active = false
      finishExecute?.()
      // no stream was opened (cannot happen: every path writes `start`): never leave readers hanging
      if (writer === undefined) closeBuffer()
    }
  })()

  const abort = (reason?: string) => {
    if (!controller.signal.aborted) controller.abort(reason ?? 'aborted')
  }
  const run = createRun<UIMessage>({
    turnId,
    kind: op.kind,
    messageId,
    stream: buffer.reader(),
    result,
    abort,
  })
  return {
    run,
    buffer,
    abort,
    steer(input, inboxId) {
      if (!inbox.open || ended) return false
      // idempotent per inbox id: a redelivered steer this turn already holds is not delivered again
      if (inboxId !== undefined) {
        if (steerIds.has(inboxId)) return true
        steerIds.add(inboxId)
      }
      const text = input.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n')
      const pushed = inbox.push(
        (async (): Promise<PendingInput | undefined> => {
          const submitted = await inputSubmit(input, 'steer')
          if ('block' in submitted) {
            // a block drops only this input; the running turn continues (spec 11 §6.1)
            rt.events.emit(
              withoutUndefined({
                type: 'input-dropped' as const,
                reason: 'blocked' as const,
                text,
                clientId: input.clientId,
              }),
            )
            if (inboxId !== undefined) host.inboxNotApplied([inboxId], { how: 'drop' })
            return undefined
          }
          const texts = submitted.input.parts.filter((p) => p.type === 'text').map((p) => p.text)
          const files = submitted.input.parts.filter((p) => p.type === 'file')
          return {
            data: withoutUndefined({
              source: 'user' as const,
              text: [...texts, ...submitted.contexts].join('\n\n'),
              files: files.length === 0 ? undefined : structuredClone(files),
              clientId: input.clientId,
              inboxId,
            }),
            steer: { input: submitted.input, contexts: submitted.contexts, text },
            ...(inboxId === undefined ? {} : { inboxId }),
          }
        })(),
      )
      if (!pushed && inboxId !== undefined) steerIds.delete(inboxId)
      return pushed
    },
    deliverEvent(message, text, wake) {
      if (!inbox.open || ended) return false
      inboxed.add(message.id)
      return inbox.push(
        Promise.resolve({
          data: { source: 'event', text },
          event: message,
          ...(wake === true ? { wake: true } : {}),
        }),
      )
    },
  }
}
