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
import type { ActiveTurn, HarnessRun, SendInput, SendOptions } from '../agent/session-types.ts'
import type { SessionCompaction } from '../compaction/compact.ts'
import { createTurnCompaction } from '../compaction/turn-context.ts'
import { currentTurnStartId } from '../compaction/turns.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
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
import { INTERRUPTED_CRASH, INTERRUPTED_TURN } from '../messages/texts.ts'
import { answerDanglingToolParts } from '../messages/tool-parts.ts'
import type {
  HarnessUIMessage,
  HarnessUsageMeta,
  PendingState,
  StopReason,
  TurnKind,
  TurnResult,
} from '../messages/types.ts'
import type { TurnInfo } from '../plugin/types.ts'
import { resolveTurnRegistry, type TurnRegistry } from '../registry/turn.ts'
import { hookFailed } from '../registry/wrap.ts'
import { describeError } from '../stream/describe-error.ts'
import { createRun, createTurnBuffer, type TurnBuffer } from '../stream/run.ts'
import { buildUserMessage, type NormalizedInput, normalizeInput } from './input.ts'
import type { OpenSession, SessionRuntime, TurnState } from './runtime.ts'
import type { StateCheckpoint } from './state.ts'

/** A turn request. */
export interface TurnOperation {
  kind: TurnKind
  input: SendInput | undefined
  options: SendOptions
  queued: boolean
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
}

/** The running turn as seen by the session (attach, abort). */
export interface RunningTurn {
  run: HarnessRun<UIMessage>
  buffer: TurnBuffer
  abort(reason?: string): void
}

const DEFAULT_MAX_STEPS = 50
const DEFAULT_MAX_OUTPUT_TOKENS = 100_000
const DEFAULT_MAX_CONTINUES = 3
const DEFAULT_STALE_MS = 120_000

type TurnError = { code?: string; message: string }

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
  return isHarnessError(error) ? { code: error.code, message } : { message }
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
  const turnId = rt.agent.generateId()
  const startedAt = Date.now()
  const recovery = config.recovery !== false
  const staleMs =
    (config.recovery === false ? undefined : config.recovery?.staleMs) ?? DEFAULT_STALE_MS

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
    addUsage: (value) => addUsage(usage, value, true),
  }
  const turnState: TurnState = {
    info,
    step: undefined,
    runtime: { ...(rt.options.runtime ?? {}), ...(op.options.runtime ?? {}) },
    active: false,
    write,
  }
  rt.turn = turnState

  /** Tool calls written to the stream that have no final result yet (toolCallId → open). */
  const openCalls = new Set<string>()
  /** Calls answered with `INTERRUPTED_TURN` chunks at the end of the turn. */
  const interrupted = new Set<string>()

  function write(chunk: UIMessageChunk): void {
    if (writer === undefined || !turnState.active) return
    buffer.push(chunk)
    if (chunk.type === 'finish-step') finishStepsWritten++
    trackToolCall(chunk)
    writer.write(chunk)
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
      if (
        pending !== undefined &&
        (pending.approvals.some((a) => a.toolCallId === toolCallId) ||
          pending.clientTools.some((c) => c.toolCallId === toolCallId))
      ) {
        continue
      }
      interrupted.add(toolCallId)
      write({ type: 'tool-output-error', toolCallId, errorText: INTERRUPTED_TURN })
    }
  }

  function writeStart(id: string, parentId: string | null | undefined): void {
    startWritten = true
    write({
      type: 'start',
      messageId: id,
      messageMetadata: {
        eharness: withoutUndefined({ v: 1, createdAt: startedAt, turnId, parentId }),
      },
    })
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
    return meta
  }

  /** Interrupted calls + message-metadata + setOutcome + finish | abort (spec 04 §2). */
  function writeEnd(): void {
    answerOpenCalls()
    const eharness: Record<string, unknown> = committed
      ? withoutUndefined({
          model: describeModel(outcome.model),
          usage: usageMeta(),
          stop: outcome.stop,
          steps: outcome.steps,
          durationMs: Date.now() - startedAt,
          pending: outcome.pending,
          error: outcome.error,
        })
      : withoutUndefined({ stop: outcome.stop, error: outcome.error })
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

  function earlyEnd(stop: StopReason, error?: unknown): void {
    if (!committed && stateCheckpoint !== undefined) rt.state.restore(stateCheckpoint)
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

  async function heartbeat(): Promise<void> {
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

    // 2. load context / validate the hot cache
    await host.ensureContext()
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
    const registry = await resolveTurnRegistry({
      open,
      approval: config.approval,
      toolOutput: config.toolOutput,
      contextOf: rt.contextOf,
      warn: rt.warn,
      status: (tool) =>
        write({ type: 'data-eh.status', data: { state: 'tool', tool }, transient: true }),
    })
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
    let normalized: NormalizedInput | undefined
    if (op.input !== undefined) {
      normalized = normalizeInput(op.input, {
        acceptClientMetadata: rt.options.acceptClientMetadata === true,
      })
    }

    // 8. input.submit (chainable, fail closed)
    let contexts: string[] = []
    if (normalized !== undefined) {
      const submitted = await inputSubmit(normalized)
      if ('block' in submitted) {
        if (submitted.block.persist !== true)
          return { kind: 'blocked', reason: submitted.block.reason }
        const floor = rt.view?.at(-1)?.id ?? null
        const recoveryNoticeId = stale === undefined ? undefined : rt.nextId()
        const user = buildUserMessage(submitted.input, {
          id: rt.nextId(),
          turnId,
          createdAt: startedAt,
          parentId: floor,
        })
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
        const out = await hook.fn(rt.contextOf(hook.owner), {
          model: info.model,
          settings: info.settings,
          options: info.options,
        })
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

    // 10. ids with the floor: recovery notice < user < assistant; then `start`
    const newest = rt.view?.at(-1)?.id ?? null
    const recoveryNoticeId = stale === undefined ? undefined : rt.nextId()
    let user: HarnessUIMessage | undefined
    if (normalized !== undefined) {
      user = buildUserMessage(
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
      )
      info.input = user
    }
    assistantId = rt.nextId()
    writeStart(assistantId, user?.id ?? newest)
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

  async function inputSubmit(
    input: NormalizedInput,
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
        out = await hook.fn(rt.contextOf(hook.owner), { message, via: 'send' })
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
    let needWrite = rt.state.dirty
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
    if (core.pending !== undefined) {
      // P2: new input while pending — projection answers the open calls; P7 adds onNewInput
      delete core.pending
      needWrite = true
    }
    if (needWrite) {
      rt.state.markDirty()
      let ok: boolean
      try {
        ok = await rt.state.write({ cas: true })
      } catch (error) {
        rt.view = undefined // force a reload of state and messages at the next operation
        throw error
      }
      if (!ok) {
        rt.view = undefined
        throw new HarnessError(
          'EH_SESSION_BUSY',
          'The session state was changed by another instance.',
        )
      }
    }
    committed = true

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
    if (prep.user !== undefined) created.push(...(await host.persist([prep.user])))
    if (prep.blockNotice !== undefined) created.push(...(await host.persist([prep.blockNotice])))
    createdBeforeAssistant = created.length
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
      outcome = { stop: 'error', steps: 0, model: info.model, error: toTurnError(error, log) }
      write({ type: 'error', errorText: outcome.error?.message ?? '' })
      return writeEnd()
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
      heartbeatTimer = setInterval(() => void heartbeat(), Math.max(1, staleMs / 4))
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
          prep.user === undefined
            ? { kind: 'no-input', assistantId: messageId }
            : { kind: 'input', userMessageId: prep.user.id },
          rt.agent.messages,
        ),
        info,
        registry,
        write,
        signal: controller.signal,
        pending: null,
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
        maxContinues: config.loop?.maxContinues ?? DEFAULT_MAX_CONTINUES,
        maxOutputTokens: config.loop?.maxTurnOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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
      })
      outcome = withoutUndefined({ ...result }) as Outcome
    } catch (error) {
      outcome = {
        stop: 'error',
        steps: outcome.steps,
        model: info.model,
        error: toTurnError(error, log),
      }
      write({ type: 'error', errorText: outcome.error?.message ?? '' })
    }
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
          try {
            await host.persist([structuredClone(message)])
          } catch (error) {
            // retried by the next step's (or the final) save
            rt.log.warn('eharness: assistant snapshot save failed; retrying at the next step', {
              error,
            })
          }
        }
      }
    } finally {
      stepEndsDone++
      checkBarrier()
    }
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
            lastStepMessage ?? {
              id: assistantId,
              role: 'assistant' as const,
              metadata: { eharness: { v: 1 as const, createdAt: startedAt, turnId } },
              parts: [],
            },
        )
        final.id = assistantId
        const pending = outcome.pending
        final = answerDanglingToolParts(final, INTERRUPTED_TURN, (part) =>
          pending === undefined
            ? false
            : pending.approvals.some((a) => a.toolCallId === part.toolCallId) ||
              pending.clientTools.some((c) => c.toolCallId === part.toolCallId),
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
        } catch (saveError) {
          stop = 'error'
          error = toTurnError(saveError, log)
          rt.cacheMessage(final)
        }
        if (outcome.stop === 'error' || outcome.stop === 'timeout') {
          const notice = createKindMessage(
            'eh.notice',
            outcome.stop === 'timeout'
              ? {
                  level: 'warning',
                  code: 'EH_TURN_TIMEOUT',
                  message: 'The turn exceeded its time limit.',
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
      if (stop === 'tool-pending' && outcome.pending !== undefined) {
        core.pending = outcome.pending
        rt.state.markDirty()
        rt.events.emit({ type: 'pending', pending: outcome.pending })
      }
      if (core.activeTurn?.turnId === turnId) {
        delete core.activeTurn
        rt.state.markDirty()
      }
      const previous = core.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
      core.usage = {
        inputTokens: previous.inputTokens + usage.input + usage.nestedInput,
        outputTokens: previous.outputTokens + usage.output + usage.nestedOutput,
        turns: previous.turns + (outcome.steps > 0 ? 1 : 0),
      }
      rt.state.markDirty()
      try {
        await rt.state.writeIfDirty()
      } catch (stateError) {
        rt.log.warn('eharness: end-of-turn state write failed', { error: stateError })
      }
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
      }),
      steps: outcome.steps,
      durationMs: Date.now() - startedAt,
      error: stop === 'error' ? error : undefined,
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
  }

  // ─── the stream ───────────────────────────────────────────────────────────────────────────
  const stream = createUIMessageStream<UIMessage>({
    generateId: () => rt.agent.generateId(),
    // also receives AI SDK echoes of error chunks already written (and described) by the core
    onError: (error) => describeError(error),
    onStepEnd: ({ responseMessage }) => onStepEnd(responseMessage as HarnessUIMessage),
    onEnd: ({ responseMessage }) => onEnd(responseMessage as HarnessUIMessage),
    execute: async ({ writer: w }) => {
      writer = w
      turnState.active = true
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
        buffer.close()
      }
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

  rt.events.emit({ type: 'status', running: true })
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
  return { run, buffer, abort }
}
