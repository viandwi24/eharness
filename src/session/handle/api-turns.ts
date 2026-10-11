import type { UIDataTypes, UIMessage, UITools } from 'ai'
import type {
  AbortRequestResult,
  ActiveTurn,
  EnqueueOptions,
  EnqueueResult,
  HarnessRun,
  InboxItemInput,
  InjectOptions,
  PendingResponse,
  SendInput,
  SendOptions,
  SteerDelivery,
  StreamLogAdapter,
} from '../../agent/session-types.ts'
import { asInvalidInputError, HarnessError, sessionBusyError } from '../../errors.ts'
import { RESPOND_IGNORE_UNKNOWN } from '../../messages/pending-state.ts'
import type { TurnResult } from '../../messages/types.ts'
import { createLogStream } from '../../stream/log-reader.ts'
import { resolveStreamLogOptions } from '../../stream/log-writer.ts'
import { createRun, failedRun } from '../../stream/run.ts'
import { toSerialized } from '../inbox/serialize.ts'
import { type NormalizedInput, normalizeInput, validateEnqueueMetadata } from '../input.ts'
import { isOwnLeftover } from '../local-turns.ts'
import { DEFAULT_STALE_MS } from '../remote-abort.ts'
import { REMOTE_START_GRACE_MS, type SessionCtx } from './ctx.ts'
import { foreignTurn, injectOnce, notify, remoteAbort } from './inbox.ts'
import { ensureOpen } from './open.ts'
import {
  assertOpen,
  begin,
  collectInput,
  dropQueue,
  enqueue,
  enqueueLocal,
  gateSend,
  touch,
} from './queue.ts'

export async function apiReady(s: SessionCtx): Promise<void> {
  assertOpen(s)
  touch(s)
  await ensureOpen(s)
}

export function apiSend(
  s: SessionCtx,
  input?: SendInput,
  options: SendOptions = {},
): HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> {
  assertOpen(s)
  // a steer or a collected input joins another turn: it cannot ask for its own typed answer
  // (spec 05 §3.3 rule 9); a run error, whether the session is busy or not
  if (
    options.output !== undefined &&
    (options.ifBusy === 'steer' || options.ifBusy === 'collect')
  ) {
    return failedRun(
      'send',
      () => s.internals.generateId(),
      new HarnessError(
        'EH_INVALID_INPUT',
        `send(…, { output }) cannot be combined with ifBusy '${options.ifBusy}'.`,
        { details: { reason: 'output-with-steer-or-collect', ifBusy: options.ifBusy } },
      ),
    )
  }
  // request-scoped tools and page context belong to one turn the same way (spec 11 §7.1)
  if (
    (options.clientTools !== undefined || options.pageContext !== undefined) &&
    (options.ifBusy === 'steer' || options.ifBusy === 'collect')
  ) {
    return failedRun(
      'send',
      () => s.internals.generateId(),
      new HarnessError(
        'EH_INVALID_INPUT',
        `send(…, { clientTools / pageContext }) cannot be combined with ifBusy '${options.ifBusy}'.`,
        {
          details: { reason: 'request-context-with-steer-or-collect', ifBusy: options.ifBusy },
        },
      ),
    )
  }
  if (s.rt.running) {
    const ifBusy = options.ifBusy ?? 'reject'
    if (ifBusy === 'reject') throw sessionBusyError(s.id)
    touch(s)
    let normalized: NormalizedInput | undefined
    try {
      normalized =
        input === undefined
          ? undefined
          : normalizeInput(input, {
              acceptClientMetadata: s.rt.options.acceptClientMetadata === true,
              files: s.config.inputFiles,
            })
    } catch (error) {
      return failedRun('send', () => s.internals.generateId(), asInvalidInputError(error))
    }
    if (ifBusy === 'wait') {
      return enqueue(s, {
        input: normalized,
        options,
        wait: { pendingAtCall: s.rt.state.core().pending?.messageId },
      })
    }
    if (ifBusy === 'collect' && normalized !== undefined) {
      return collectInput(s, normalized, options.collect, undefined, true) as HarnessRun<UIMessage>
    }
    if (ifBusy === 'steer') {
      // where the input went (spec 05 §2): a step of the running turn, a turn of its own, or nowhere
      let settle!: (outcome: SteerDelivery) => void
      const delivery = new Promise<SteerDelivery>((resolve) => {
        settle = resolve
      })
      if (s.current !== undefined && normalized !== undefined) {
        if (s.current.steer(normalized, undefined, settle)) {
          return { ...(s.session.attach() as HarnessRun<UIMessage>), delivery }
        }
      }
      // a turn that stopped taking input (or none to take it): a queued turn of its own,
      // and the caller gets that turn's run (spec 11 §6.1)
      settle('turn')
      return { ...enqueue(s, { input: normalized, options }), delivery }
    }
    return enqueue(s, { input: normalized, options })
  }
  if (s.drain !== undefined && options.ifBusy !== 'steer') {
    let normalized: NormalizedInput | undefined
    try {
      normalized =
        input === undefined
          ? undefined
          : normalizeInput(input, {
              acceptClientMetadata: s.rt.options.acceptClientMetadata === true,
              files: s.config.inputFiles,
            })
    } catch (error) {
      return failedRun('send', () => s.internals.generateId(), asInvalidInputError(error))
    }
    return gateSend(s, normalized, options)
  }
  const started = begin(s, { kind: 'send', input, options, queued: false })
  // a steer with nothing running starts a turn of its own
  return options.ifBusy === 'steer'
    ? { ...started, delivery: Promise.resolve<SteerDelivery>('turn') }
    : started
}

export function apiRespond(
  s: SessionCtx,
  response: PendingResponse,
  options: SendOptions = {},
): HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> {
  assertOpen(s)
  const ignoreUnknown =
    (options as SendOptions & { [RESPOND_IGNORE_UNKNOWN]?: boolean })[RESPOND_IGNORE_UNKNOWN] ===
    true
  if (s.rt.running) {
    if (options.ifBusy !== 'wait') throw sessionBusyError(s.id)
    touch(s)
    return enqueue(s, {
      kind: 'respond',
      input: undefined,
      options,
      wait: { pendingAtCall: undefined },
      respond: { response, ignoreUnknown },
    })
  }
  return begin(s, {
    kind: 'respond',
    input: undefined,
    options,
    queued: false,
    respond: { response, ignoreUnknown },
  })
}

export function apiRegenerate(
  s: SessionCtx,
  options: { messageId?: string } & SendOptions = {},
): HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> {
  assertOpen(s)
  if (s.rt.running) throw sessionBusyError(s.id)
  const { messageId, ...rest } = options
  return begin(s, {
    kind: 'regenerate',
    input: undefined,
    options: rest,
    queued: false,
    ...(messageId === undefined ? {} : { target: messageId }),
  })
}

export function apiEdit(
  s: SessionCtx,
  { messageId, input, ...options }: { messageId: string; input: SendInput } & SendOptions,
): HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> {
  assertOpen(s)
  if (s.rt.running) throw sessionBusyError(s.id)
  return begin(s, { kind: 'edit', input, options, queued: false, target: messageId })
}

export function apiOnRun(
  s: SessionCtx,
  listener: (run: HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never>) => void,
): () => void {
  assertOpen(s)
  s.runListeners.add(listener)
  return () => {
    s.runListeners.delete(listener)
  }
}

export function apiAttach(
  s: SessionCtx,
): HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> | undefined {
  assertOpen(s)
  const running = s.current
  if (running === undefined) return undefined
  return createRun({
    turnId: running.run.turnId,
    kind: running.run.kind,
    messageId: running.run.messageId,
    stream: running.buffer.replayReader(),
    result: running.run.result,
    abort: running.abort,
  })
}

export async function apiAttachRemote(
  s: SessionCtx,
  options: { from?: number | undefined; signal?: AbortSignal | undefined } | undefined = {},
): Promise<HarnessRun<UIMessage<unknown, UIDataTypes, UITools>, never> | undefined> {
  assertOpen(s)
  const from = Math.max(0, Math.floor(options.from ?? 0))
  // a turn of this process: the turn buffer, no extra latency
  const running = s.current
  if (running !== undefined) {
    return createRun({
      turnId: running.run.turnId,
      kind: running.run.kind,
      messageId: running.run.messageId,
      stream: running.buffer.replayReader(from),
      result: running.run.result,
      abort: running.abort,
    })
  }
  const adapter = s.args.streams
  if (adapter === undefined) return undefined
  const streamOptions = resolveStreamLogOptions(s.config.streams)
  const staleMs =
    s.config.recovery === false ? undefined : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS)
  const readActive = async (): Promise<ActiveTurn | undefined> => {
    const stored = await s.args.state.get(s.id)
    const active = stored?.core?.activeTurn
    if (active === undefined) return undefined
    // a turn this instance id owns but does not run: left by a previous process (stable
    // `recovery.instanceId`), nothing will ever write to its log (spec 05 §9.2)
    if (isOwnLeftover(s.rt, active)) return undefined
    if (staleMs !== undefined && Date.now() - active.heartbeatAt > staleMs) return undefined
    return active
  }
  let active: ActiveTurn | undefined
  try {
    active = await readActive()
  } catch (error) {
    s.log.warn('eharness: attachRemote could not read the session state', { error })
    return undefined
  }
  if (active === undefined) return undefined
  const key = { sessionId: s.id, turnId: active.turnId }
  // the owner flushes in batches: right after the commit point the log may not exist yet
  const deadline = Math.max(active.startedAt, Date.now() - 1) + REMOTE_START_GRACE_MS
  for (;;) {
    let probe: Awaited<ReturnType<StreamLogAdapter['read']>>
    try {
      probe = await adapter.read(key, from, { limit: 1 })
    } catch (error) {
      s.log.warn('eharness: attachRemote could not read the stream log', { error })
      return undefined
    }
    if (probe.status !== 'missing') break
    if (options.signal?.aborted || Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, Math.min(streamOptions.pollMs, 100)))
  }
  if (options.signal?.aborted) return undefined
  const { stream, ended } = createLogStream({
    adapter,
    key,
    from,
    pollMs: streamOptions.pollMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // a failing probe is counted by the reader, which ends with `EH_STORAGE` after a few
    isActive: async () => (await readActive())?.turnId === active.turnId,
    warn: (message, data) => s.log.warn(message, { sessionId: s.id, ...data }),
  })
  const startedAt = active.startedAt
  const result = ended.then((end): TurnResult<UIMessage> => {
    const stop = (end.stop ??
      (end.status === 'aborted' ? 'aborted' : 'error')) as TurnResult<UIMessage>['stop']
    return {
      turnId: active.turnId,
      kind: active.kind,
      stop,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
    }
  })
  return createRun({
    turnId: active.turnId,
    kind: active.kind,
    messageId: Promise.resolve(active.messageId),
    stream,
    result,
    abort: (reason) => {
      s.session
        .abort(reason)
        .catch((error: unknown) =>
          s.log.warn('eharness: cross-process abort request failed', { error }),
        )
    },
  })
}

export async function apiAbort(
  s: SessionCtx,
  reason: string | undefined,
): Promise<AbortRequestResult> {
  assertOpen(s)
  dropQueue(s, false)
  if (s.current !== undefined) {
    s.current.abort(reason)
    return { target: 'local' }
  }
  return remoteAbort(s, reason)
}

export async function apiInject(
  s: SessionCtx,
  kind: string,
  data: unknown,
  options: InjectOptions | undefined = {},
): Promise<never> {
  const flightKey = options.key
  if (typeof flightKey === 'string' && flightKey !== '') {
    // concurrent calls with the same key share one in-flight call: exactly one message
    const running = s.injectFlights.get(flightKey)
    if (running !== undefined) {
      const first = await running
      return { message: structuredClone(first.message) } as never
    }
    const flight = injectOnce(s, kind, data, options)
    s.injectFlights.set(flightKey, flight)
    try {
      return (await flight) as never
    } finally {
      if (s.injectFlights.get(flightKey) === flight) s.injectFlights.delete(flightKey)
    }
  }
  return injectOnce(s, kind, data, options) as never
}

export async function apiEnqueue(
  s: SessionCtx,
  input: SendInput,
  options: EnqueueOptions | undefined = {},
): Promise<
  | { inboxId: string; target: 'local'; duplicate: true }
  | { inboxId: string; target: 'local' | 'remote'; duplicate?: undefined }
> {
  assertOpen(s)
  const mode = options.mode ?? 'queue'
  if (mode !== 'queue' && mode !== 'steer' && mode !== 'collect') {
    throw new HarnessError('EH_INVALID_INPUT', `Unknown enqueue mode '${String(mode)}'.`, {
      details: { mode },
    })
  }
  const callerId = options.id
  if (
    callerId !== undefined &&
    (typeof callerId !== 'string' || callerId.length === 0 || callerId.length > 256)
  ) {
    throw new HarnessError('EH_INVALID_INPUT', 'enqueue id must be a string of 1-256 characters.')
  }
  const availableAt = options.availableAt
  if (availableAt !== undefined) {
    if (typeof availableAt !== 'number' || !Number.isFinite(availableAt)) {
      throw new HarnessError('EH_INVALID_INPUT', 'enqueue availableAt must be epoch milliseconds.')
    }
    if (mode === 'collect') {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        "enqueue availableAt is not supported with mode 'collect'.",
      )
    }
  }
  touch(s)
  const normalized = normalizeInput(input, {
    acceptClientMetadata: s.rt.options.acceptClientMetadata === true,
    files: s.config.inputFiles,
  })
  if (options.metadata !== undefined) {
    normalized.app = validateEnqueueMetadata(options.metadata)
  }
  const inbox = s.args.inbox
  if (inbox === undefined || s.drain === undefined) {
    if (availableAt !== undefined && availableAt > Date.now()) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        'enqueue availableAt needs storage.inbox (a durable timer).',
      )
    }
    if (callerId !== undefined) {
      const known = s.localEnqueueIds.get(callerId)
      if (known !== undefined) return { inboxId: known, target: 'local', duplicate: true }
    }
    const inboxId = s.internals.generateId()
    if (callerId !== undefined) s.localEnqueueIds.set(callerId, inboxId)
    s.events.emit({ type: 'inbox-enqueued', inboxId, kind: 'send', mode })
    enqueueLocal(s, normalized, mode, inboxId, options.collect, callerId)
    return { inboxId, target: 'local' }
  }
  const item: InboxItemInput = {
    kind: 'send',
    mode,
    input: toSerialized(normalized),
    at: Date.now(),
    ...(options.collect === undefined ? {} : { collect: { ...options.collect } }),
    ...(availableAt === undefined ? {} : { availableAt }),
  }
  let inboxId: string
  try {
    if (callerId === undefined) {
      inboxId = await inbox.enqueue(s.id, item)
    } else {
      if (inbox.enqueueOnce === undefined) {
        throw new HarnessError(
          'EH_INVALID_INPUT',
          'enqueue id needs an inbox adapter that implements enqueueOnce.',
        )
      }
      const stored = await inbox.enqueueOnce(s.id, { ...item, dedupeKey: callerId })
      if (stored.duplicate) return { inboxId: stored.id, target: 'local', duplicate: true }
      inboxId = stored.id
    }
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'EH_INVALID_INPUT') throw error
    throw new HarnessError('EH_STORAGE', 'Inbox storage failed (enqueue).', { cause: error })
  }
  s.events.emit({ type: 'inbox-enqueued', inboxId, kind: 'send', mode })
  let target: EnqueueResult['target'] = 'local'
  if (s.current === undefined && !s.rt.running) {
    const foreign = await foreignTurn(s)
    if (foreign !== undefined) {
      target = 'remote'
      s.drain.foreign(foreign)
    }
  }
  if (target === 'remote') await notify(s)
  else s.drain.drain()
  if (availableAt !== undefined && availableAt > Date.now()) s.drain.wakeAt(availableAt)
  return { inboxId, target }
}
