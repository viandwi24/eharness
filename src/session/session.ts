/**
 * The live session (internal implementation of `HarnessSession`): open, hot cache, turn
 * operations, reads, events, close.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
import { asSchema, type LanguageModel, type Tool, type UIMessage, type UIMessageChunk } from 'ai'
import type { AgentInternals } from '../agent/internals.ts'
import type {
  HarnessRun,
  HarnessSession,
  MessageAdapter,
  SessionOptions,
  StateAdapter,
} from '../agent/session-types.ts'
import { HarnessError, type HarnessWarning, isHarnessError } from '../errors.ts'
import { estimateTokens } from '../loop/steps.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { project } from '../messages/project.ts'
import type { ContextStats, HarnessUIMessage, TurnKind, TurnResult } from '../messages/types.ts'
import type { HarnessContext, HarnessLogger } from '../plugin/types.ts'
import {
  addContribution,
  createStaticRegistry,
  describeOwner,
  type HookEntry,
  type NormalizedInstruction,
} from '../registry/static.ts'
import type { ToolInput, ToolSource } from '../registry/types.ts'
import { hookFailed } from '../registry/wrap.ts'
import { createRun, createTurnBuffer } from '../stream/run.ts'
import { createContext, defaultLogger, pendingServices } from './context.ts'
import { createEventHub } from './events.ts'
import { createHookRunner } from './hooks.ts'
import { hiddenByRewind, loadContext, rewindsIn } from './load-context.ts'
import type { OpenSession, ResolvedTool, SessionRuntime } from './runtime.ts'
import { createStateStore } from './state.ts'
import { type RunningTurn, startTurn, type TurnHost } from './turn.ts'

/** Default context window when none is configured (spec 06 §1). */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** A live session plus the handles the agent needs. */
export interface SessionHandle {
  readonly session: HarnessSession<UIMessage, Record<string, unknown>>
  readonly rt: SessionRuntime
  close(): Promise<void>
}

function closedError(id: string): HarnessError {
  return new HarnessError(
    'EH_SESSION_CLOSED',
    `Session '${id}' was closed or evicted; call agent.session(id) again.`,
    { details: { sessionId: id } },
  )
}

function busyError(id: string): HarnessError {
  return new HarnessError('EH_SESSION_BUSY', `A turn of session '${id}' is running.`, {
    details: { sessionId: id },
  })
}

function notImplemented(what: string, phase: string): HarnessError {
  return new HarnessError('EH_NOT_IMPLEMENTED', `${what} is not implemented yet (phase ${phase}).`)
}

/** A run that fails before it starts (valid stream: start → error → message-metadata → finish). */
function failedRun(
  kind: TurnKind,
  generateId: () => string,
  error: HarnessError,
): HarnessRun<UIMessage> {
  const buffer = createTurnBuffer()
  const turnId = generateId()
  const messageId = generateId()
  const chunks: UIMessageChunk[] = [
    { type: 'start', messageId },
    { type: 'error', errorText: error.message },
    {
      type: 'message-metadata',
      messageMetadata: {
        eharness: { stop: 'error', error: { code: error.code, message: error.message } },
      },
    },
    { type: 'finish' },
  ]
  for (const chunk of chunks) buffer.push(chunk)
  buffer.close()
  const result: TurnResult<UIMessage> = {
    turnId,
    kind,
    stop: 'error',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    steps: 0,
    durationMs: 0,
    error: { code: error.code, message: error.message },
  }
  return createRun({
    turnId,
    kind,
    messageId: Promise.resolve(messageId),
    stream: buffer.reader(),
    result: Promise.resolve(result),
    abort: () => {},
  })
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

function storageError(what: string, cause: unknown): HarnessError {
  if (isHarnessError(cause)) return cause
  return new HarnessError('EH_STORAGE', `Message storage failed (${what}).`, { cause })
}

/** Create a live session. */
export function createSessionHandle(args: {
  internals: AgentInternals
  owner: string
  id: string
  options: SessionOptions
  messages: MessageAdapter
  state: StateAdapter
  idleMs: number
  onClosed(): void
}): SessionHandle {
  const { internals, id } = args
  const config = internals.config
  const log: HarnessLogger = config.logger ?? defaultLogger
  const closeController = new AbortController()
  const events = createEventHub()
  const contexts = new Map<string, HarnessContext>()
  let customIdWarned = false

  const rt: SessionRuntime = {
    id,
    agent: internals,
    options: args.options,
    messages: args.messages,
    state: createStateStore(args.state, id),
    owner: args.owner,
    log,
    signal: closeController.signal,
    events,
    open: undefined,
    view: undefined,
    newestId: undefined,
    storedLastId: undefined,
    turn: undefined,
    running: false,
    closed: false,
    warn(warning: HarnessWarning, key?: string) {
      internals.emitWarning(warning, key)
      const chunk = {
        type: 'data-eh.warning' as const,
        data: { code: warning.code, message: warning.message },
        transient: true,
      }
      if (rt.turn?.active === true) rt.turn.write(chunk)
      else events.emit({ type: 'data', chunk: chunk as never })
    },
    nextId() {
      const floor = rt.newestId
      const next = internals.generateId(floor)
      if (
        floor !== undefined &&
        !(next > floor) &&
        config.generateId !== undefined &&
        !customIdWarned
      ) {
        customIdWarned = true
        log.warn(
          `eharness: config.generateId returned '${next}', which does not sort after the session's newest id '${floor}' (spec 03 §8).`,
        )
      }
      if (floor === undefined || next > floor) rt.newestId = next
      return next
    },
    contextOf(plugin: string) {
      let ctx = contexts.get(plugin)
      if (ctx === undefined) {
        ctx = createContext(rt, plugin)
        contexts.set(plugin, ctx)
      }
      return ctx
    },
    cacheMessage(message: HarnessUIMessage) {
      if (rt.newestId === undefined || message.id > rt.newestId) rt.newestId = message.id
      const view = rt.view
      if (view === undefined) return
      const copy = structuredClone(message)
      let index = view.length
      while (index > 0 && (view[index - 1] as HarnessUIMessage).id > message.id) index--
      if (index > 0 && (view[index - 1] as HarnessUIMessage).id === message.id)
        view[index - 1] = copy
      else view.splice(index, 0, copy)
    },
  }

  // ─── open (state load + plugin session phases) ────────────────────────────────────────────
  let opening: Promise<OpenSession> | undefined
  /** The state was just loaded by open(); the first context load must not reload it. */
  let stateFresh = false

  const pluginOrder = internals.plugins.map((p) => p.name)
  const rank = (owner: string) => pluginOrder.indexOf(owner)

  async function doOpen(): Promise<OpenSession> {
    const parent = rt.options.parent
    if (parent !== undefined && parent.depth > 8) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        'Child sessions deeper than 8 levels are not allowed.',
        {
          details: { depth: parent.depth },
        },
      )
    }
    await rt.state.load()
    stateFresh = true
    const services = new Map<string, unknown>()
    pendingServices.set(rt, services)
    const disposers: OpenSession['disposers'] = []
    const session = createStaticRegistry()
    try {
      for (const plugin of internals.plugins) {
        const def = plugin['~def']
        const provides = def.provides ?? []
        if (def.session === undefined) {
          if (provides.length > 0) missingService(plugin.name, provides[0] as string)
          continue
        }
        let contribution: Awaited<ReturnType<NonNullable<typeof def.session>>>
        try {
          contribution = await def.session.call(def, rt.contextOf(plugin.name) as never)
        } catch (error) {
          if (isHarnessError(error)) throw error
          throw new HarnessError(
            'EH_CONFIG_INVALID',
            `${describeOwner(plugin.name)}: session() threw: ${error instanceof Error ? error.message : String(error)}`,
            { details: { owner: plugin.name }, cause: error },
          )
        }
        if (contribution === undefined || contribution === null) {
          if (provides.length > 0) missingService(plugin.name, provides[0] as string)
          continue
        }
        if (typeof contribution.dispose === 'function') {
          const dispose = contribution.dispose.bind(contribution)
          disposers.push({ owner: plugin.name, dispose })
        }
        const provided = (contribution.services ?? {}) as Record<string, unknown>
        for (const name of provides) {
          if (!(name in provided)) missingService(plugin.name, name)
          services.set(name, provided[name])
        }
        for (const name of Object.keys(provided)) {
          if (!provides.includes(name)) {
            throw new HarnessError(
              'EH_CONFIG_INVALID',
              `Plugin '${plugin.name}' returned service '${name}' without declaring it in \`provides\`.`,
              { details: { plugin: plugin.name, service: name } },
            )
          }
        }
        addContribution(session, plugin.name, contribution, 'session')
      }

      // session contributions must not collide with static ones (spec 02 §7)
      for (const tool of session.tools) {
        const existing = internals.statics.tools.find((t) => t.name === tool.name)
        if (existing !== undefined) {
          throw new HarnessError(
            'EH_DUPLICATE_TOOL',
            `Tool '${tool.name}' is declared twice: by ${describeOwner(existing.owner)} and by ${describeOwner(tool.owner)}.`,
            { details: { tool: tool.name, owners: [existing.owner, tool.owner] } },
          )
        }
      }
      for (const skill of session.skills) {
        const existing = internals.statics.skills.find((s) => s.skill.name === skill.skill.name)
        if (existing !== undefined) {
          throw new HarnessError(
            'EH_DUPLICATE_SKILL',
            `Skill '${skill.skill.name}' is declared twice: by ${describeOwner(existing.owner)} and by ${describeOwner(skill.owner)}.`,
            { details: { skill: skill.skill.name, owners: [existing.owner, skill.owner] } },
          )
        }
      }

      const byPlugin = <T extends { owner: string }>(setup: T[], sessionItems: T[]): T[] =>
        [
          ...setup.map((item, i) => ({ item, key: rank(item.owner) * 2, i })),
          ...sessionItems.map((item, i) => ({ item, key: rank(item.owner) * 2 + 1, i })),
        ]
          .sort((a, b) => a.key - b.key || a.i - b.i)
          .map((x) => x.item)

      const instructions: NormalizedInstruction[] = byPlugin(
        internals.statics.instructions,
        session.instructions,
      )
      const hookEntries: HookEntry[] = [...internals.statics.hooks, ...session.hooks]
      const hooks = createHookRunner(hookEntries, pluginOrder)

      // (ctx) => Tool inputs, resolved after every session phase ran (spec 02 §3.1)
      const tools: ResolvedTool[] = []
      for (const entry of byPlugin(internals.statics.tools, session.tools)) {
        tools.push({
          owner: entry.owner,
          name: entry.name,
          tool: resolveTool(entry.owner, entry.name, entry.tool),
        })
      }
      const toolSources: Array<{ owner: string; source: ToolSource }> = byPlugin(
        internals.statics.toolSources,
        session.toolSources,
      )
      for (const { owner, source } of toolSources) {
        if (typeof source.open === 'function') await source.open(rt.contextOf(owner))
        if (typeof source.close === 'function') {
          const close = source.close.bind(source)
          disposers.push({ owner, dispose: close })
        }
      }
      const open: OpenSession = {
        services,
        hooks,
        tools,
        toolSources,
        instructions,
        sessionBlock: undefined,
        sourceCache: new Map(),
        disposers,
      }
      rt.open = open
      pendingServices.delete(rt)
      for (const hook of hooks.list('session.start')) {
        try {
          await hook.fn(rt.contextOf(hook.owner))
        } catch (error) {
          hookFailed(rt, 'session.start', hook.owner, error)
        }
      }
      return open
    } catch (error) {
      rt.open = undefined
      pendingServices.delete(rt)
      for (const { dispose } of [...disposers].reverse()) {
        try {
          await dispose()
        } catch {}
      }
      throw error
    }
  }

  function missingService(plugin: string, service: string): never {
    throw new HarnessError(
      'EH_SERVICE_MISSING',
      `Plugin '${plugin}' declares service '${service}' in \`provides\` but its session() did not return it.`,
      { details: { plugin, service } },
    )
  }

  function resolveTool(owner: string, name: string, input: ToolInput): Tool {
    if (typeof input !== 'function') return input
    let tool: unknown
    try {
      tool = input(rt.contextOf(owner))
    } catch (error) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `${describeOwner(owner)}: tool '${name}' factory threw: ${error instanceof Error ? error.message : String(error)}`,
        { details: { owner, tool: name }, cause: error },
      )
    }
    if (typeof tool !== 'object' || tool === null) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `${describeOwner(owner)}: tool '${name}' factory must return an AI SDK tool.`,
        { details: { owner, tool: name } },
      )
    }
    return tool as Tool
  }

  function ensureOpen(): Promise<OpenSession> {
    if (rt.open !== undefined) return Promise.resolve(rt.open)
    if (opening === undefined) {
      opening = doOpen().catch((error: unknown) => {
        opening = undefined
        throw error
      })
    }
    return opening
  }

  // ─── context (cold load / hot cache validation) ───────────────────────────────────────────
  async function ensureContext(validate = false): Promise<void> {
    const adapter = rt.messages
    if (validate && rt.view !== undefined && adapter.lastId !== undefined) {
      let last: string | null
      try {
        last = await adapter.lastId(id)
      } catch (error) {
        throw storageError('lastId', error)
      }
      // another writer changed the session: reload state and messages (spec 05 §6)
      if (last !== (rt.storedLastId ?? null)) rt.view = undefined
    }
    if (rt.view !== undefined) return
    if (!stateFresh) await rt.state.load()
    stateFresh = false
    const loaded = await loadContext({
      adapter,
      sessionId: id,
      registry: internals.messages,
      policy: rt.options.onInvalidMessage ?? 'drop',
      core: rt.state.core(),
      markDirty: () => rt.state.markDirty(),
    })
    for (const warning of loaded.warnings) {
      rt.warn(warning, String(warning.details?.type ?? warning.details?.messageId ?? ''))
    }
    rt.view = loaded.view
    rt.storedLastId = loaded.newestId
    if (
      loaded.newestId !== undefined &&
      (rt.newestId === undefined || loaded.newestId > rt.newestId)
    ) {
      rt.newestId = loaded.newestId
    }
  }

  async function persist(messages: HarnessUIMessage[]): Promise<HarnessUIMessage[]> {
    const out: HarnessUIMessage[] = []
    for (const original of messages) {
      let message = original
      for (const hook of rt.open?.hooks.list('message.beforeSave') ?? []) {
        try {
          const next = await hook.fn(rt.contextOf(hook.owner), structuredClone(message))
          if (next === undefined || next === null) continue
          if (next.id !== message.id || next.role !== message.role) {
            throw new Error('message.beforeSave must keep the message id and role')
          }
          message = next
        } catch (error) {
          hookFailed(rt, 'message.beforeSave', hook.owner, error)
        }
      }
      out.push(message)
    }
    try {
      await rt.messages.save(id, out)
    } catch (error) {
      throw storageError('save', error)
    }
    for (const message of out) {
      rt.cacheMessage(message)
      if (rt.storedLastId === undefined || message.id > rt.storedLastId)
        rt.storedLastId = message.id
    }
    return out
  }

  let windowWarned = false
  function stats(
    model: LanguageModel,
    parts: { instructions: string; tools: number; wire: unknown },
  ): ContextStats {
    let window: number | undefined
    const configured = config.contextWindow
    if (typeof configured === 'number') window = configured
    else if (typeof configured === 'function') window = configured(model)
    if (window === undefined || !(window > 0)) {
      window = DEFAULT_CONTEXT_WINDOW
      if (!windowWarned) {
        windowWarned = true
        rt.warn(
          {
            code: 'W_DEFAULT_CONTEXT_WINDOW',
            message: `No contextWindow configured for model '${typeof model === 'string' ? model : `${model.provider}/${model.modelId}`}'; using ${DEFAULT_CONTEXT_WINDOW}.`,
          },
          'window',
        )
      }
    }
    const instructions = estimateTokens(parts.instructions || undefined)
    const messages = estimateTokens(parts.wire)
    const reserve =
      config.guard?.reserveTokens ?? config.settings?.maxOutputTokens ?? Math.floor(window * 0.08)
    const summarizeAt =
      config.compaction === false ? 0.75 : (config.compaction?.summarizeAt ?? 0.75)
    return {
      window,
      tokens: instructions + parts.tools + messages,
      instructions,
      tools: parts.tools,
      messages,
      summarizeAt: Math.floor(window * summarizeAt),
      hardLimit: Math.floor(window * (config.guard?.maxContextRatio ?? 0.9) - reserve),
    }
  }

  // ─── turns ────────────────────────────────────────────────────────────────────────────────
  let current: RunningTurn | undefined
  const host: TurnHost = {
    rt,
    ensureOpen,
    ensureContext: () => ensureContext(true),
    persist,
    stats,
    onTurnEnd() {
      current = undefined
      touch()
    },
  }

  function assertOpen(): void {
    if (rt.closed) throw closedError(id)
  }

  // ─── idle eviction ────────────────────────────────────────────────────────────────────────
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  function touch(): void {
    if (args.idleMs <= 0 || rt.closed) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (rt.running || events.readers > 0) touch()
      else void close()
    }, args.idleMs)
    unref(idleTimer)
  }

  // ─── close ────────────────────────────────────────────────────────────────────────────────
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (closing !== undefined) return closing
    rt.closed = true
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    closing = (async () => {
      const running = current
      if (running !== undefined) {
        running.abort('closed')
        await running.run.result
      }
      closeController.abort('closed')
      const open = rt.open
      if (open === undefined && opening !== undefined) {
        try {
          await opening
        } catch {}
      }
      if (rt.open !== undefined) {
        for (const hook of rt.open.hooks.list('session.close')) {
          try {
            await hook.fn(rt.contextOf(hook.owner))
          } catch (error) {
            hookFailed(rt, 'session.close', hook.owner, error)
          }
        }
        for (const { owner, dispose } of [...rt.open.disposers].reverse()) {
          try {
            await dispose()
          } catch (error) {
            log.warn(`eharness: dispose of ${describeOwner(owner)} failed`, { error })
          }
        }
        try {
          await rt.state.writeIfDirty()
        } catch (error) {
          log.warn('eharness: state write on close failed', { error })
        }
      }
      events.close()
      args.onClosed()
    })()
    return closing
  }

  const session: HarnessSession<UIMessage, Record<string, unknown>> = {
    id,
    get running() {
      return rt.running
    },
    async ready() {
      assertOpen()
      touch()
      await ensureOpen()
    },
    send(input, options = {}) {
      assertOpen()
      if (rt.running) throw busyError(id) // ifBusy 'queue' / 'steer' arrive with P7
      rt.running = true
      touch()
      current = startTurn(host, { kind: 'send', input, options, queued: false })
      return current.run
    },
    respond() {
      assertOpen()
      if (rt.running) throw busyError(id)
      return failedRun('respond', () => internals.generateId(), notImplemented('respond()', 'P7'))
    },
    regenerate() {
      assertOpen()
      if (rt.running) throw busyError(id)
      return failedRun(
        'regenerate',
        () => internals.generateId(),
        notImplemented('regenerate()', 'P7'),
      )
    },
    edit() {
      assertOpen()
      if (rt.running) throw busyError(id)
      return failedRun('edit', () => internals.generateId(), notImplemented('edit()', 'P7'))
    },
    attach() {
      assertOpen()
      const running = current
      if (running === undefined) return undefined
      return createRun({
        turnId: running.run.turnId,
        kind: running.run.kind,
        messageId: running.run.messageId,
        stream: running.buffer.reader(),
        result: running.run.result,
        abort: running.abort,
      })
    },
    abort(reason) {
      assertOpen()
      current?.abort(reason)
    },
    async inject(kind, data, options = {}) {
      assertOpen()
      if (options.deliver === 'next-step' || options.wake === true) {
        throw notImplemented("inject() with deliver: 'next-step' or wake", 'P7')
      }
      const registered = internals.messages.kind(kind)
      if (registered === undefined) {
        throw new HarnessError('EH_INVALID_INPUT', `Unknown message kind '${kind}'.`, {
          details: { kind },
        })
      }
      const validate = asSchema(registered.def.schema).validate
      let value: unknown = data
      if (validate !== undefined) {
        const result = await validate(data)
        if (!result.success) {
          throw new HarnessError(
            'EH_INVALID_INPUT',
            `Invalid payload for kind '${kind}': ${result.error.message}`,
            { details: { kind }, cause: result.error },
          )
        }
        value = result.value
      }
      touch()
      await ensureOpen()
      if (rt.view === undefined) await ensureContext()
      const message = createKindMessage(kind, value, {
        id: rt.nextId(),
        role: registered.def.role,
        createdAt: Date.now(),
        parentId: rt.view?.at(-1)?.id ?? null,
        ...(rt.turn === undefined ? {} : { turnId: rt.turn.info.id }),
      })
      const [saved] = await persist([message])
      const out = saved ?? message
      events.emit({ type: 'message', message: out as never })
      return { message: structuredClone(out) as never }
    },
    async compact() {
      assertOpen()
      if (rt.running) throw busyError(id)
      throw notImplemented('compact()', 'P3')
    },
    async clearGrants() {
      assertOpen()
      await ensureOpen()
      const core = rt.state.core()
      if (core.grants === undefined) return
      delete core.grants
      rt.state.markDirty()
      await rt.state.writeIfDirty()
    },
    async messages(q = {}) {
      assertOpen()
      touch()
      let page: HarnessUIMessage[]
      try {
        page = (await rt.messages.load({
          sessionId: id,
          limit: q.limit ?? 50,
          ...(q.beforeId === undefined ? {} : { beforeId: q.beforeId }),
        })) as HarnessUIMessage[]
      } catch (error) {
        throw storageError('load', error)
      }
      if (q.includeHidden === true) return page as never
      const rewinds = [
        ...(rt.state.loaded ? (rt.state.core().rewinds ?? []) : []),
        ...rewindsIn(page),
      ]
      if (rewinds.length === 0) return page as never
      return page.filter((m) => !hiddenByRewind(m, rewinds, internals.messages)) as never
    },
    async stats() {
      assertOpen()
      touch()
      const open = await ensureOpen()
      if (rt.view === undefined) await ensureContext()
      const model = config.model
      const wire = await project(rt.view ?? [], {
        registry: internals.messages,
        sessionId: id,
        model,
      })
      const instructions = open.instructions
        .filter((i) => i.kind === 'static')
        .map((i) => (i.kind === 'static' ? i.text : ''))
      if (open.sessionBlock) instructions.push(open.sessionBlock)
      const tools = open.tools.reduce(
        (sum, t) => sum + estimateTokens({ name: t.name, description: t.tool.description ?? '' }),
        0,
      )
      const core = rt.state.core()
      return {
        ...stats(model, { instructions: instructions.join('\n\n'), tools, wire }),
        pending: core.pending ?? null,
        activeTurn: core.activeTurn ?? null,
      }
    },
    events() {
      assertOpen()
      touch()
      return events.stream() as never
    },
    close,
  }
  touch()
  return { session, rt, close }
}
