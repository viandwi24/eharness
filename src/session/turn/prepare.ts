import type { ActiveTurn } from '../../agent/session-types.ts'
import { HarnessError, isHarnessError, lockFailure } from '../../errors.ts'
import { hookFailed, runHook } from '../../internal/hook-run.ts'
import { describeModel } from '../../internal/model.ts'
import { observeSpan } from '../../internal/observe.ts'
import { mergeSettings } from '../../loop/step-settings.ts'
import { createKindMessage } from '../../messages/kinds.ts'
import { INPUT_CHECK_FAILED } from '../../messages/texts.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { lookupModel, unsupportedInputMessage } from '../../models/catalog.ts'
import { DEFAULT_OUTPUT_TOOL, prepareTurnOutput, withOutputTool } from '../../output/turn.ts'
import { resolveTurnRegistry } from '../../registry/turn.ts'
import { buildUserMessage, type NormalizedInput, normalizeInput } from '../input.ts'
import {
  applyRecord,
  pendingSignature,
  planRespond,
  viewHoldsPending,
} from '../interaction/pending.ts'
import { createRewind, type RewindTarget, resolveRewindTarget } from '../interaction/rewind.ts'
import { validateExternalAnswers } from '../interaction/waits.ts'
import { isOwnLeftover } from '../local-turns.ts'
import type { Prepared, TurnCtx } from './ctx.ts'
import { validateWith } from './helpers.ts'
import { currentGrants, write, writeStart } from './output.ts'

/**
 * Run `fn` as preparation work of `owner`: its `ctx.state` changes are discarded if the turn
 * ends before the commit point; foreign changes (other plugins, core state such as
 * `clearGrants()`) are kept (spec 05 §3).
 */
export async function asOwner<T>(
  t: TurnCtx,
  owners: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  for (const owner of owners) t.preparing.set(owner, (t.preparing.get(owner) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    for (const owner of owners) {
      const n = (t.preparing.get(owner) ?? 1) - 1
      if (n <= 0) t.preparing.delete(owner)
      else t.preparing.set(owner, n)
    }
  }
}

export async function prepare(t: TurnCtx): Promise<Prepared> {
  // 1. lock + open
  const lock = t.rt.options.lock
  if (lock !== undefined) {
    try {
      t.releaseLock = await observeSpan(
        t.rt.agent.observe,
        'lock.wait',
        { sessionId: t.rt.id, turnId: t.turnId },
        () => lock.acquire(t.rt.id, { signal: t.controller.signal }),
      )
    } catch (error) {
      // contention is EH_SESSION_BUSY, a failing lock service EH_LOCK_UNAVAILABLE (spec 05 §8)
      if (!isHarnessError(error, 'EH_SESSION_BUSY')) {
        t.rt.log.warn('eharness: acquiring the session lock failed', { error })
      }
      throw lockFailure(t.rt.id, error)
    }
  }
  const open = await t.host.ensureOpen()
  if (t.controller.signal.aborted) return { kind: 'aborted' }

  // 2. load context / validate the hot cache; respond() re-reads the state (freshest pending)
  await t.host.ensureContext()
  if (t.rt.state.dirty) {
    // unwritten local changes (usually healed pointers) on top of a state another instance has
    // written since: they cannot be merged and would keep this handle blind to the foreign
    // pending state / active turn forever (a respond() answering "nothing is waiting"). Take the
    // stored state; the heals run again on the reloaded messages (fuzz seed 99).
    const stored = await t.rt.state.peek()
    if ((stored?.rev ?? 0) !== t.rt.state.snapshot().rev) {
      await t.rt.state.load()
      t.rt.view = undefined
      await t.host.ensureContext()
    }
  }
  if (t.op.kind === 'respond' && !t.rt.state.dirty) await t.rt.state.load()
  else if (t.rt.state.core().pending !== undefined && !t.rt.state.dirty) {
    // the cache says "pending": another instance may have resolved it meanwhile (external
    // waits, spec 11 §4.2) — and patched the pending message, which keeps its id, so the
    // `lastId` check above cannot see it: reload the state, and the messages when it changed
    const before = pendingSignature(t.rt.state.core().pending)
    await t.rt.state.load()
    if (pendingSignature(t.rt.state.core().pending) !== before) {
      t.rt.view = undefined
      await t.host.ensureContext()
    }
  }
  // the cache is consistent with the state it was validated against: the message the stored
  // pending state names must be the newest non-kind message of the view, with all its pending
  // calls. The `lastId` check cannot see another instance patching an older message (a pending
  // message continued with new calls, a turn of another instance saved while this one stored a
  // newer event): reload the messages (fuzz seeds 115, 360).
  {
    const held = t.rt.state.core().pending
    if (held !== undefined && t.rt.view !== undefined && !t.rt.state.dirty) {
      if (!viewHoldsPending(t.rt.view, held)) {
        t.rt.view = undefined
        await t.host.ensureContext()
      }
    }
  }
  // hooks of the preparation may change ctx.state: discarded if the turn ends before committing
  t.stateCheckpoint = t.rt.state.checkpoint()

  // 3. active-turn check (spec 05 §9)
  let stale: ActiveTurn | undefined
  const active = t.rt.state.core().activeTurn
  if (t.recovery && active !== undefined && active.turnId !== t.turnId) {
    const isStale =
      isOwnLeftover(t.rt, active) ||
      t.releaseLock !== undefined ||
      Date.now() - active.heartbeatAt > t.staleMs
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
  const core = t.rt.state.core()
  const view = t.rt.view ?? []
  if (t.op.kind === 'respond') {
    for (let attempt = 0; ; attempt++) {
      t.plan = planRespond({
        pending: t.rt.state.core().pending,
        response: t.op.respond?.response ?? {},
        view: t.rt.view ?? view,
        ignoreUnknown: t.op.respond?.ignoreUnknown === true,
      })
      if (t.plan.complete) break
      // a partial answer: record it with a compare-and-set and end (ADR-0044). Another
      // instance may record meanwhile: reload and plan again — the last answer continues.
      applyRecord(t.plan)
      t.rt.state.markDirty()
      if (await t.rt.state.write({ cas: true })) {
        t.stateCheckpoint = undefined // the recorded answers are kept, not reverted
        return { kind: 'partial', pending: structuredClone(t.plan.pending) }
      }
      if (attempt >= 5) {
        throw new HarnessError(
          'EH_SESSION_BUSY',
          'The session state kept changing while the answers were recorded; try again.',
        )
      }
      t.rt.state.discard()
      await t.rt.state.load()
    }
    // results of `respond({ externals })` are checked like `resolveWait()` results
    if (t.plan.externals.length > 0)
      await validateExternalAnswers(t.rt, await t.host.ensureOpen(), t.plan)
  } else if (core.pending !== undefined) {
    if (t.config.approval?.onNewInput === 'reject') {
      throw new HarnessError(
        'EH_PENDING_RESPONSE',
        'Tool approvals or client tool calls are waiting; call respond() first.',
        { details: { messageId: core.pending.messageId } },
      )
    }
    t.denyPending = core.pending
  }
  let target: RewindTarget | undefined
  if (t.op.kind === 'regenerate' || t.op.kind === 'edit') {
    target = resolveRewindTarget({
      view,
      registry: t.rt.agent.messages,
      role: t.op.kind === 'edit' ? 'user' : 'assistant',
      messageId: t.op.target,
    })
  }
  /** Generate the rewind id first (id order: rewind < notices < user < assistant). */
  const makeRewind = () => {
    if (target === undefined) return
    t.rewind = createRewind({
      id: t.rt.nextId(),
      afterId: target.afterId,
      reason: t.op.kind === 'edit' ? 'edit' : 'regenerate',
      turnId: t.turnId,
      createdAt: t.startedAt,
      parentId: target.afterId,
    })
  }

  // 5. options and per-turn settings
  if (t.config.callOptions !== undefined) {
    t.info.options = await validateWith(
      t.config.callOptions,
      t.op.options.options,
      'SendOptions.options',
    )
  }
  const timeout = t.info.settings.timeout
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
  const outputSpec = t.op.options.output
  const resolved = await asOwner(t, sourceOwners, () =>
    resolveTurnRegistry({
      clientTools: t.op.options.clientTools,
      clientToolsOptions: t.op.options.clientToolsOptions,
      pageContext: t.op.options.pageContext,
      pageContextOptions: t.op.options.pageContextOptions,
      // the output tool's name is the server's: a client can never take it (spec 11 §7.1 rule 2)
      reservedNames:
        outputSpec !== undefined && outputSpec.mode !== 'native'
          ? [outputSpec.toolName ?? DEFAULT_OUTPUT_TOOL]
          : [],
      open,
      approval: t.config.approval,
      toolOutput: t.config.toolOutput,
      toolOrder: t.config.toolOrder,
      deferTools: t.config.deferTools,
      toolErrorText: t.config.toolErrorText,
      hookTimeoutMs: t.hookTimeoutMs,
      signal: t.controller.signal,
      contextOf: t.rt.contextOf,
      warn: t.rt.warn,
      observe: t.rt.agent.observe,
      sessionId: t.rt.id,
      turnId: t.turnId,
      status: (tool) =>
        write(t, { type: 'data-eh.status', data: { state: 'tool', tool }, transient: true }),
      grants: { current: () => currentGrants(t) },
    }),
  )
  // request-scoped tools change the cached prefix (tools → system → messages): warn once per
  // turn when the declared set differs from the previous turn of this session (spec 11 §7.1).
  // A continuation without declarations (a timeout, `resolveWait()`) is no client request: the
  // client is gone, so it neither warns nor resets the comparison.
  if (t.op.kind !== 'respond' || resolved.requestToolsSignature !== '') {
    if (
      open.requestToolsSignature !== undefined &&
      open.requestToolsSignature !== resolved.requestToolsSignature
    ) {
      t.rt.warn(
        {
          code: 'W_CACHE_BUST',
          message:
            'The request-scoped client tools differ from the previous turn; the cached prompt prefix is rebuilt.',
          details: { reason: 'client-tools' },
        },
        `${t.turnId}:client-tools`,
      )
    }
    open.requestToolsSignature = resolved.requestToolsSignature
  }
  // structured output (spec 05 §3.3 rule 1): validate the spec; tool mode appends its tool last
  t.turnOutput = await prepareTurnOutput(t.op.options.output, new Set(Object.keys(resolved.tools)))
  const registry = withOutputTool(resolved, t.turnOutput)
  const toolsContext =
    t.rt.options.toolsContext === undefined && t.op.options.toolsContext === undefined
      ? undefined
      : { ...(t.rt.options.toolsContext ?? {}), ...(t.op.options.toolsContext ?? {}) }
  for (const entry of registry.entries) {
    const schema = entry.tool.contextSchema
    if (schema === undefined) continue
    await validateWith(schema, toolsContext?.[entry.name], `toolsContext of tool '${entry.name}'`)
  }

  // 7. normalize input
  let normalized: NormalizedInput | undefined = t.op.submitted?.input ?? t.op.normalized
  if (normalized === undefined && t.op.input !== undefined) {
    normalized = normalizeInput(t.op.input, {
      acceptClientMetadata: t.rt.options.acceptClientMetadata === true,
      files: t.config.inputFiles,
    })
  }
  if (t.op.kind === 'edit' && normalized === undefined) {
    throw new HarnessError('EH_INVALID_INPUT', 'edit() needs the replacement input.')
  }
  if (normalized !== undefined && target !== undefined && t.op.kind === 'edit') {
    // the replaced message's client id is carried over so the UI can reconcile (spec 11 §5)
    normalized = {
      ...normalized,
      clientId: target.message.metadata?.eharness?.clientId ?? target.message.id,
    }
  }

  // 8. input.submit (chainable, fail closed)
  let contexts: string[] = t.op.submitted?.contexts ?? []
  if (normalized !== undefined && t.op.submitted === undefined) {
    const submitted = await inputSubmit(
      t,
      normalized,
      t.op.via ?? (t.op.kind === 'edit' ? 'edit' : 'send'),
    )
    if ('block' in submitted) {
      if (submitted.block.persist !== true)
        return { kind: 'blocked', reason: submitted.block.reason }
      const floor = target === undefined ? (t.rt.view?.at(-1)?.id ?? null) : target.afterId
      makeRewind()
      const recoveryNoticeId = stale === undefined ? undefined : t.rt.nextId()
      const user = withInboxMeta(
        t,
        buildUserMessage(submitted.input, {
          id: t.rt.nextId(),
          turnId: t.turnId,
          createdAt: t.startedAt,
          parentId: floor,
        }),
      )
      t.info.input = user
      const blockNotice = createKindMessage(
        'eh.notice',
        { level: 'warning', code: 'EH_INPUT_BLOCKED', message: submitted.block.reason },
        { id: t.rt.nextId(), turnId: t.turnId, createdAt: Date.now(), parentId: user.id },
      )
      writeStart(t, t.rt.agent.generateId(), undefined) // no assistant message for a block
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
      const out = await observeSpan(
        t.rt.agent.observe,
        'turn.prepare',
        { sessionId: t.rt.id, turnId: t.turnId, hook: 'turn.prepare', owner: hook.owner },
        () =>
          runHook(
            () =>
              asOwner(t, [hook.owner], async () =>
                hook.fn(t.rt.contextOf(hook.owner), {
                  model: t.info.model,
                  settings: t.info.settings,
                  options: t.info.options,
                }),
              ),
            {
              hook: 'turn.prepare',
              owner: hook.owner,
              timeoutMs: t.hookTimeoutMs,
              signal: t.controller.signal,
            },
          ),
      )
      if (out === undefined || out === null) continue
      if (out.model !== undefined) t.info.model = out.model
      if (out.settings !== undefined) t.info.settings = mergeSettings(t.info.settings, out.settings)
      if (out.activeTools !== undefined) {
        const allowed = new Set(out.activeTools)
        activeTools =
          activeTools === undefined
            ? [...out.activeTools]
            : activeTools.filter((name) => allowed.has(name))
      }
    } catch (error) {
      hookFailed(t.rt, 'turn.prepare', hook.owner, error)
    }
  }
  if (t.controller.signal.aborted) return { kind: 'aborted' }

  // 9b. input modalities: a file the model cannot read fails here, before the commit point, with a
  //     readable error instead of the provider's (spec 12 §1.1). Input of the inbox (enqueue,
  //     collect) and steers have no caller to read the error: they are accepted, and projection
  //     shows the model a note.
  if (
    normalized !== undefined &&
    t.config.models !== undefined &&
    t.op.inbox === undefined &&
    t.op.submitted === undefined
  ) {
    const files = normalized.parts.filter((p) => p.type === 'file') as Array<{
      mediaType: string
      filename?: string
    }>
    if (files.length > 0) {
      const modelName = describeModel(t.info.model)
      const refused = unsupportedInputMessage(
        lookupModel(t.config.models, t.info.model),
        modelName,
        files,
      )
      if (refused !== undefined) {
        throw new HarnessError('EH_INVALID_INPUT', refused.message, {
          details: { reason: 'unsupported-modality', modality: refused.modality, model: modelName },
        })
      }
    }
  }

  // 10. ids with the floor: rewind < recovery notice < user < assistant; then `start` (a
  //     continuation keeps A's id and writes `start` after the commit point, with A')
  const newest = target === undefined ? (t.rt.view?.at(-1)?.id ?? null) : target.afterId
  makeRewind()
  const recoveryNoticeId = stale === undefined ? undefined : t.rt.nextId()
  let user: HarnessUIMessage | undefined
  if (normalized !== undefined) {
    user = withInboxMeta(
      t,
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
          id: t.rt.nextId(),
          turnId: t.turnId,
          createdAt: t.startedAt,
          parentId: newest,
          augmented: contexts.length,
        },
      ),
    )
    t.info.input = user
  }
  if (t.plan !== undefined) {
    t.assistantId = t.plan.pending.messageId
  } else {
    t.assistantId = t.rt.nextId()
    writeStart(t, t.assistantId, user?.id ?? newest)
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
export function withInboxMeta(t: TurnCtx, user: HarnessUIMessage): HarnessUIMessage {
  const meta = t.op.inbox?.meta
  const eharness = user.metadata?.eharness
  if (meta === undefined || eharness === undefined) return user
  if ('inboxId' in meta) {
    eharness.inboxId = meta.inboxId
    if (meta.key !== undefined) eharness.inboxKey = meta.key
  } else eharness.collected = structuredClone(meta.collected)
  return user
}

export async function inputSubmit(
  t: TurnCtx,
  input: NormalizedInput,
  via: 'send' | 'edit' | 'steer' | 'queue',
): Promise<
  | { input: NormalizedInput; contexts: string[] }
  | { input: NormalizedInput; block: { reason: string; persist?: boolean } }
> {
  const open = t.rt.open
  let current = input
  const contexts: string[] = []
  for (const hook of open?.hooks.list('input.submit') ?? []) {
    const message = buildUserMessage(current, {
      id: current.clientId ?? '',
      turnId: t.turnId,
      createdAt: t.startedAt,
    })
    let out: Awaited<ReturnType<typeof hook.fn>>
    try {
      out = await runHook(
        () =>
          asOwner(t, [hook.owner], async () =>
            hook.fn(t.rt.contextOf(hook.owner), { message, via }),
          ),
        {
          hook: 'input.submit',
          owner: hook.owner,
          timeoutMs: t.hookTimeoutMs,
          signal: t.controller.signal,
        },
      )
    } catch (error) {
      // fail closed, but never show the raw error to the end user (it can carry hosts, keys)
      hookFailed(t.rt, 'input.submit', hook.owner, error)
      t.rt.log.error('eharness: the input.submit hook failed; the input was blocked', {
        hook: 'input.submit',
        owner: hook.owner,
        error,
      })
      return { input: current, block: { reason: INPUT_CHECK_FAILED } }
    }
    if (out === undefined || out === null) continue
    if ('block' in out) return { input: current, block: out.block }
    if ('message' in out) {
      const renormalized = normalizeInput(out.message, {
        acceptClientMetadata: t.rt.options.acceptClientMetadata === true,
        files: t.config.inputFiles,
      })
      current = { ...renormalized }
      // `metadata.app` is server-set (enqueue): a hook cannot change or drop it
      if (input.app === undefined) delete current.app
      else current.app = input.app
      if (input.clientId === undefined) delete current.clientId
      else current.clientId = input.clientId
    } else if ('context' in out && Array.isArray(out.context)) {
      for (const text of out.context)
        if (typeof text === 'string' && text.length > 0) contexts.push(text)
    }
  }
  return { input: current, contexts }
}
