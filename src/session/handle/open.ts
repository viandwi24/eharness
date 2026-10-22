import type { Tool } from 'ai'
import type { ParentInfo, StateAdapter } from '../../agent/session-types.ts'
import { HarnessError, isHarnessError, storageError } from '../../errors.ts'
import { hookFailed, hookTimeoutOf, runHook } from '../../internal/hook-run.ts'
import { observeSpan } from '../../internal/observe.ts'
import { errorText } from '../../internal/util.ts'
import { normalizeDeniedApprovals, normalizeRawInput } from '../../messages/tool-parts.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { checkMessageShape } from '../../messages/validate.ts'
import { toolTokens } from '../../models/tokens.ts'
import {
  addContribution,
  createStaticRegistry,
  describeOwner,
  duplicateSkillError,
  type HookEntry,
  type NormalizedInstruction,
} from '../../registry/static.ts'
import { inspectRegistry, type RegistryInspection } from '../../registry/turn.ts'
import type { ToolInput, ToolSource } from '../../registry/types.ts'
import { buildSessionSkills } from '../../skills/registry.ts'
import { pendingServices } from '../context.ts'
import { registerChild } from '../family.ts'
import { createHookRunner } from '../hooks.ts'
import { checkSessionInvariants } from '../invariants.ts'
import { loadContext } from '../load-context.ts'
import type { OpenSession, ResolvedTool } from '../runtime.ts'
import type { SessionCtx } from './ctx.ts'

export function rank(s: SessionCtx, owner: string): number {
  return s.pluginOrder.indexOf(owner)
}

export async function doOpen(s: SessionCtx): Promise<OpenSession> {
  const parent = s.rt.options.parent
  if (parent !== undefined && parent.depth > 8) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      'Child sessions deeper than 8 levels are not allowed.',
      {
        details: { depth: parent.depth },
      },
    )
  }
  await s.rt.state.load()
  s.stateFresh = true
  if (parent !== undefined) await linkParent(s, parent)
  const services = new Map<string, unknown>()
  pendingServices.set(s.rt, services)
  const disposers: OpenSession['disposers'] = []
  const session = createStaticRegistry()
  try {
    for (const plugin of s.internals.plugins) {
      const def = plugin['~def']
      const provides = def.provides ?? []
      if (def.session === undefined) {
        if (provides.length > 0) missingService(s, plugin.name, provides[0] as string)
        continue
      }
      let contribution: Awaited<ReturnType<NonNullable<typeof def.session>>>
      try {
        contribution = await def.session.call(def, s.rt.contextOf(plugin.name) as never)
      } catch (error) {
        if (isHarnessError(error)) throw error
        throw new HarnessError(
          'EH_CONFIG_INVALID',
          `${describeOwner(plugin.name)}: session() threw: ${errorText(error)}`,
          { details: { owner: plugin.name }, cause: error },
        )
      }
      if (contribution === undefined || contribution === null) {
        if (provides.length > 0) missingService(s, plugin.name, provides[0] as string)
        continue
      }
      if (typeof contribution.dispose === 'function') {
        const dispose = contribution.dispose.bind(contribution)
        disposers.push({ owner: plugin.name, dispose })
      }
      const provided = (contribution.services ?? {}) as Record<string, unknown>
      for (const name of provides) {
        if (!(name in provided)) missingService(s, plugin.name, name)
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
      const existing = s.internals.statics.tools.find((t) => t.name === tool.name)
      if (existing !== undefined) {
        throw new HarnessError(
          'EH_DUPLICATE_TOOL',
          `Tool '${tool.name}' is declared twice: by ${describeOwner(existing.owner)} and by ${describeOwner(tool.owner)}.`,
          { details: { tool: tool.name, owners: [existing.owner, tool.owner] } },
        )
      }
    }
    for (const skill of session.skills) {
      const existing = s.internals.statics.skills.find((s) => s.skill.name === skill.skill.name)
      if (existing !== undefined) {
        throw duplicateSkillError(skill.skill.name, existing, skill)
      }
    }

    const byPlugin = <T extends { owner: string }>(setup: T[], sessionItems: T[]): T[] =>
      [
        ...setup.map((item, i) => ({ item, key: rank(s, item.owner) * 2, i })),
        ...sessionItems.map((item, i) => ({ item, key: rank(s, item.owner) * 2 + 1, i })),
      ]
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((x) => x.item)

    const instructions: NormalizedInstruction[] = byPlugin(
      s.internals.statics.instructions,
      session.instructions,
    )
    const hookEntries: HookEntry[] = [...s.internals.statics.hooks, ...session.hooks]
    const hooks = createHookRunner(hookEntries, s.pluginOrder)

    // (ctx) => Tool inputs, resolved after every session phase ran (spec 02 §3.1)
    const tools: ResolvedTool[] = []
    for (const entry of byPlugin(s.internals.statics.tools, session.tools)) {
      tools.push({
        owner: entry.owner,
        name: entry.name,
        tool: resolveTool(s, entry.owner, entry.name, entry.tool),
      })
    }
    const toolSources: Array<{ owner: string; source: ToolSource }> = byPlugin(
      s.internals.statics.toolSources,
      session.toolSources,
    )
    for (const { owner, source } of toolSources) {
      if (typeof source.open === 'function') await source.open(s.rt.contextOf(owner))
      if (typeof source.close === 'function') {
        const close = source.close.bind(source)
        disposers.push({ owner, dispose: close })
      }
    }
    const open: OpenSession = {
      skills: buildSessionSkills(
        byPlugin(s.internals.statics.skills, session.skills),
        byPlugin(s.internals.statics.skillSources, session.skillSources),
        s.pluginOrder,
        s.internals.config.skillsIndexLimit,
      ),
      services,
      hooks,
      tools,
      toolSources,
      instructions,
      sessionBlock: undefined,
      sourceCache: new Map(),
      sourceFailures: new Map(),
      sourceOptions: s.internals.config.toolSources ?? {},
      disposers,
    }
    s.rt.open = open
    pendingServices.delete(s.rt)
    for (const hook of hooks.list('session.start')) {
      try {
        await runHook(() => hook.fn(s.rt.contextOf(hook.owner)), {
          hook: 'session.start',
          owner: hook.owner,
          timeoutMs: hookTimeoutOf(s.rt.agent.config),
        })
      } catch (error) {
        hookFailed(s.rt, 'session.start', hook.owner, error)
      }
    }
    // waits a crashed instance parked but never started (spec 11 §4.2 rule 1); not awaited: a
    // `start` may call back into this session
    queueMicrotask(() => void s.waits.redispatch())
    return open
  } catch (error) {
    s.rt.open = undefined
    pendingServices.delete(s.rt)
    // what was opened for this attempt releases its per-session resources (spec 05 §2)
    s.sessionController.abort('open failed')
    if (!s.rt.closed) s.sessionController = new AbortController()
    for (const { dispose } of [...disposers].reverse()) {
      try {
        await dispose()
      } catch {}
    }
    throw error
  }
}

/**
 * A child session records its parent in its own state and registers in the parent's
 * `core.children` (a foreign write through the state adapter, spec 05 §13). Best effort: a
 * failure is logged and retried by the next open (the child's `core.parent` is only recorded
 * after the registration went through).
 */
export async function linkParent(s: SessionCtx, parent: ParentInfo): Promise<void> {
  const core = s.rt.state.core()
  const known = core.parent
  if (
    known !== undefined &&
    known.sessionId === parent.sessionId &&
    known.turnId === parent.turnId &&
    known.toolCallId === parent.toolCallId
  ) {
    return
  }
  try {
    await registerChild(s.args.state, parent.sessionId, {
      sessionId: s.id,
      turnId: parent.turnId,
      ...(parent.toolCallId === undefined ? {} : { toolCallId: parent.toolCallId }),
      ...(parent.agent === undefined ? {} : { agent: parent.agent }),
      ...(parent.name === undefined ? {} : { name: parent.name }),
      ...(parent.description === undefined ? {} : { description: parent.description }),
      createdAt: Date.now(),
    })
    core.parent = { ...parent }
    s.rt.state.markDirty()
    await s.rt.state.writeIfDirty()
  } catch (error) {
    s.log.warn(
      `eharness: could not register session '${s.id}' as a child of '${parent.sessionId}'`,
      {
        error,
      },
    )
  }
}

export function missingService(_s: SessionCtx, plugin: string, service: string): never {
  throw new HarnessError(
    'EH_SERVICE_MISSING',
    `Plugin '${plugin}' declares service '${service}' in \`provides\` but its session() did not return it.`,
    { details: { plugin, service } },
  )
}

export function resolveTool(s: SessionCtx, owner: string, name: string, input: ToolInput): Tool {
  if (typeof input !== 'function') return input
  let tool: unknown
  try {
    tool = input(s.rt.contextOf(owner))
  } catch (error) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `${describeOwner(owner)}: tool '${name}' factory threw: ${errorText(error)}`,
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

export function ensureOpen(s: SessionCtx): Promise<OpenSession> {
  if (s.rt.open !== undefined) return Promise.resolve(s.rt.open)
  if (s.opening === undefined) {
    const after = s.args.after
    // one live handle per id: a handle created while the previous one closes opens after it
    const start =
      after === undefined
        ? doOpen(s)
        : after.then(
            () => doOpen(s),
            () => doOpen(s),
          )
    s.opening = start.catch((error: unknown) => {
      s.opening = undefined
      throw error
    })
  }
  return s.opening
}

export async function ensureContext(s: SessionCtx, validate = false): Promise<void> {
  if (s.loading !== undefined) return s.loading
  const adapter = s.rt.messages
  if (validate && s.rt.view !== undefined && adapter.lastId !== undefined) {
    let last: string | null
    try {
      last = await adapter.lastId(s.id)
    } catch (error) {
      throw storageError('Message', 'lastId', error)
    }
    if (s.loading !== undefined) return s.loading
    // another writer changed the session: reload state and messages (spec 05 §6)
    if (last !== (s.rt.storedLastId ?? null)) s.rt.view = undefined
  }
  if (s.rt.view !== undefined) return
  s.loading = loadView(s).finally(() => {
    s.loading = undefined
    s.cachedWhileLoading = undefined
  })
  return s.loading
}

export async function loadView(s: SessionCtx): Promise<void> {
  s.cachedWhileLoading = []
  if (!s.stateFresh) await s.rt.state.load()
  s.stateFresh = false
  const loaded = await loadContext({
    adapter: s.rt.messages,
    sessionId: s.id,
    registry: s.internals.messages,
    policy: s.rt.options.onInvalidMessage ?? 'drop',
    core: s.rt.state.core(),
    markDirty: () => s.rt.state.markDirty(),
  })
  for (const warning of loaded.warnings) {
    s.rt.warn(warning, String(warning.details?.type ?? warning.details?.messageId ?? ''))
  }
  const late = s.cachedWhileLoading ?? []
  s.rt.view = loaded.view
  s.rt.storedLastId = loaded.newestId
  if (
    loaded.newestId !== undefined &&
    (s.rt.newestId === undefined || loaded.newestId > s.rt.newestId)
  ) {
    s.rt.newestId = loaded.newestId
  }
  // saved while the load was in flight: never lost from the hot cache
  for (const message of late) {
    s.rt.cacheMessage(message)
    if (s.rt.storedLastId === undefined || message.id > s.rt.storedLastId)
      s.rt.storedLastId = message.id
  }
}

/** `debug.invariants`: report an inconsistent session at the end of a turn (spec 05 §15). */
export async function reportInvariants(s: SessionCtx): Promise<void> {
  try {
    if (s.rt.view === undefined || s.rt.closed) return
    const problems = await checkSessionInvariants(s.rt.state.snapshot(), s.rt.view, {
      registry: s.internals.messages,
      skipSchema: true,
    })
    if (problems.length === 0) return
    s.rt.warn(
      {
        code: 'W_INVARIANT_VIOLATION',
        message: `Session ${s.id} violates invariants after a turn: ${problems.join('; ')}`,
        details: { sessionId: s.id, problems },
      },
      problems.join('|'),
    )
  } catch {
    // a failing check never affects the session
  }
}

export async function persist(
  s: SessionCtx,
  messages: HarnessUIMessage[],
): Promise<HarnessUIMessage[]> {
  const out: HarnessUIMessage[] = []
  for (const original of messages) {
    let message = normalizeDeniedApprovals(normalizeRawInput(original))
    for (const hook of s.rt.open?.hooks.list('message.beforeSave') ?? []) {
      try {
        const next = await runHook(
          () => hook.fn(s.rt.contextOf(hook.owner), structuredClone(message)),
          {
            hook: 'message.beforeSave',
            owner: hook.owner,
            timeoutMs: hookTimeoutOf(s.rt.agent.config),
          },
        )
        if (next === undefined || next === null) continue
        if (next.id !== message.id || next.role !== message.role) {
          throw new HarnessError(
            'EH_CONFIG_INVALID',
            'message.beforeSave must keep the message id and role',
          )
        }
        message = next
      } catch (error) {
        hookFailed(s.rt, 'message.beforeSave', hook.owner, error)
      }
    }
    // cached token estimate of the projection (spec 06 §2)
    out.push(await s.compaction.annotate(normalizeDeniedApprovals(message)))
  }
  for (const message of out) {
    const problem = await checkMessageShape(message, s.internals.messages)
    if (problem === undefined) continue
    if (s.debugInvariants) {
      throw new HarnessError(
        'EH_INVALID_MESSAGE',
        `The core is about to save an invalid message ${message.id}: ${problem}`,
        { details: { messageId: message.id, reason: problem } },
      )
    }
    // never drop a message (it may hold pending state); report and save it
    s.rt.warn(
      {
        code: 'W_INVALID_MESSAGE',
        message: `Message ${message.id} fails UIMessage validation and was saved as is: ${problem}`,
        details: { messageId: message.id, reason: problem, stage: 'save' },
      },
      message.id,
    )
  }
  try {
    await observeSpan(s.internals.observe, 'message.write', { sessionId: s.id }, () =>
      s.rt.messages.save(s.id, out),
    )
  } catch (error) {
    throw storageError('Message', 'save', error)
  }
  for (const message of out) {
    s.rt.cacheMessage(message)
    if (s.rt.storedLastId === undefined || message.id > s.rt.storedLastId)
      s.rt.storedLastId = message.id
  }
  // observe-only: the messages are stored now (spec 01 §5, `message.saved`)
  for (const hook of s.rt.open?.hooks.list('message.saved') ?? []) {
    try {
      await runHook(() => hook.fn(s.rt.contextOf(hook.owner), structuredClone(out)), {
        hook: 'message.saved',
        owner: hook.owner,
        timeoutMs: hookTimeoutOf(s.rt.agent.config),
      })
    } catch (error) {
      hookFailed(s.rt, 'message.saved', hook.owner, error)
    }
  }
  return out
}

/**
 * The next request as an idle session sees it: instructions (turn-refresh ones evaluated),
 * skills, tools in request order (spec 02 §3.4). Resolves tool sources like a turn would.
 */
export async function inspect(s: SessionCtx, open: OpenSession): Promise<RegistryInspection> {
  return inspectRegistry({
    open,
    toolOrder: s.config.toolOrder,
    deferTools: s.config.deferTools,
    hookTimeoutMs: hookTimeoutOf(s.config),
    contextOf: s.rt.contextOf,
    warn: s.rt.warn,
  })
}

/** Uncalibrated tokens of the instructions and tools of the next request (and their split). */
export async function staticTokens(
  s: SessionCtx,
  open: OpenSession,
): Promise<{
  instructions: number
  tools: number
  inspection: RegistryInspection
}> {
  const inspection = await inspect(s, open)
  const text = [inspection.block1, inspection.block2, inspection.turnReminder]
    .filter((t): t is string => t !== undefined)
    .join('\n\n')
  let tools = 0
  // deferred tools are not sent until discovered (spec 02 §3.3): they cost nothing here
  for (const e of inspection.entries) {
    if (e.tool.deferLoading === true) continue
    tools += await toolTokens(e.name, e.tool, s.compaction.count)
  }
  return { instructions: text.length === 0 ? 0 : s.compaction.count(text), tools, inspection }
}

/** `state.core.rewinds` read straight from the adapter (cold reads, spec 05 §2). */
export async function storedRewinds(
  s: SessionCtx,
): Promise<Array<{ afterId: string | null; rewindId: string }>> {
  let snapshot: Awaited<ReturnType<StateAdapter['get']>>
  try {
    snapshot = await s.args.state.get(s.id)
  } catch (error) {
    throw storageError('Message', 'state get', error)
  }
  const rewinds = snapshot?.core?.rewinds
  return Array.isArray(rewinds) ? [...rewinds] : []
}
