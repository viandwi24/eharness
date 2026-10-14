/**
 * Park mode (ADR-0035): the child-side `turn.end` hook that resolves the parent's wait, crash
 * recovery of waits, and the readers a web UI needs (`pendingSubagentApprovals`).
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import {
  type ChildSessionInfo,
  definePlugin,
  errorText,
  type HarnessContext,
  type HarnessPlugin,
  isHarnessError,
  isLongRunCheckpoint,
  neutralizeTags,
  type PendingState,
  type SessionContribution,
  type SessionOptions,
  type SessionPeek,
  type TurnResult,
  WAIT_CANCELLED_NEW_INPUT,
} from '../index.ts'
import { drain, finalText, sleep } from './child-run.ts'
import { parseAgentFrame } from './messaging.ts'
import {
  deliverReport,
  type MessageLike,
  reportKey,
  reportOf,
  statusOfStop,
  stoppedText,
  textOf,
} from './report.ts'
import {
  AGENT_REPORT_MAX_CHARS,
  type AnyAgent,
  type AnyRun,
  type AnySession,
  BACKGROUND_KEY,
  BACKGROUND_STATE,
} from './types.ts'

/** Default bound of a background child (one hour); see `background.timeoutMs`. */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 3_600_000

/** The wait id of an `agent` tool call (`externalTool()` uses `w_<toolCallId>`). */
export const subagentWaitId = (toolCallId: string): string => `w_${toolCallId}`

/** The wait result for a child turn that ended with `stop` (spec 20 §3 step 5). */
function waitResultFor(
  stop: string,
  text: string,
  errorMessage: string | undefined,
): { output: unknown } | { errorText: string } {
  if (stop === 'complete') return { output: text === '' ? '(the subagent returned no text)' : text }
  if (stop === 'error' || stop === 'aborted') {
    return {
      errorText: `ERROR: subagent ${stop === 'aborted' ? 'was aborted' : 'failed'}${
        errorMessage === undefined ? '' : `: ${errorMessage}`
      }${text === '' ? '' : `\n${text}`}`,
    }
  }
  return { output: stoppedText(stop, text) }
}

/** `resolveWait()` plus the continuation run handling; `'busy'` when the parent runs a turn. */
async function settleWait(
  parentSession: AnySession,
  waitId: string,
  result: { output: unknown } | { errorText: string },
  o: {
    onParentRun: ((run: AnyRun, parentSessionId: string) => void) | undefined
    parentSessionId: string
    log: { warn(message: string, data?: Record<string, unknown>): void }
  },
): Promise<'done' | 'busy'> {
  try {
    const out = await parentSession.resolveWait(waitId, result)
    if (out.status === 'continued') {
      const run = out.run as AnyRun
      if (o.onParentRun !== undefined) o.onParentRun(run, o.parentSessionId)
      else drain(run)
    }
    return 'done'
  } catch (error) {
    if (isHarnessError(error) && error.code === 'EH_SESSION_BUSY') return 'busy'
    o.log.warn('subagent: resolving the parent wait failed', { error: errorText(error) })
    return 'done'
  }
}

/** Outcome of one wait in {@link reconcileSubagentWaits}. */
export interface SubagentReconcileEntry {
  waitId: string
  childSessionId: string
  /** `resolved`: this call resolved it; `busy`: the parent runs a turn (retry later); `skipped`: the child is not finished (or not found). */
  status: 'resolved' | 'busy' | 'skipped'
}

/**
 * Crash recovery for `approvals: 'park'` (ADR-0035): resolves the parent's pending subagent waits
 * whose child already finished, exactly like the child's `turn.end` hook would. Use it when a
 * parent session opens, on a timer, or from an admin endpoint. Idempotent: the first result of a
 * wait wins, so racing the hook or another instance is harmless.
 *
 * A wait is considered when it has no result and names a child session (payload
 * `childSessionId` or the `correlationId`); the child is opened with `openChild`. It is skipped
 * while the child has pending approvals, an active turn, no assistant message yet, or its last
 * turn stopped `tool-pending`.
 */
export async function reconcileSubagentWaits(
  parentSession: AnySession,
  options: {
    openChild: (childSessionId: string, info: { agent?: string; toolCallId: string }) => AnySession
    onParentRun?: (run: AnyRun, parentSessionId: string) => void
    log?: { warn(message: string, data?: Record<string, unknown>): void }
  },
): Promise<SubagentReconcileEntry[]> {
  const log = options.log ?? { warn() {} }
  const out: SubagentReconcileEntry[] = []
  const waits = await parentSession.pendingWaits()
  const children = await parentSession.children()
  for (const wait of waits) {
    if (wait.result !== undefined || !wait.waitId.startsWith('w_')) continue
    const payload = wait.payload as { childSessionId?: unknown; background?: unknown } | undefined
    // a durable background child answered its call at once: its report is an event (ADR-0046)
    if (payload?.background === true) continue
    const toolCallId = wait.waitId.slice(2)
    const childSessionId =
      typeof payload?.childSessionId === 'string'
        ? payload.childSessionId
        : (children.find((c) => c.toolCallId === toolCallId)?.sessionId ?? wait.correlationId)
    if (childSessionId === undefined) continue
    const entry = { waitId: wait.waitId, childSessionId }
    try {
      const agent = (payload as { agent?: unknown } | undefined)?.agent
      const child = options.openChild(childSessionId, {
        toolCallId,
        ...(typeof agent === 'string' ? { agent } : {}),
      })
      const stats = await child.stats()
      if (stats.pending !== null || stats.activeTurn !== null) {
        out.push({ ...entry, status: 'skipped' })
        continue
      }
      const stored = (await child.messages()) as unknown as Array<
        MessageLike & {
          metadata?: { eharness?: { stop?: string; error?: { message: string } } }
        }
      >
      const last = stored.findLast((m) => m.role === 'assistant')
      const stop = last?.metadata?.eharness?.stop
      if (last === undefined || stop === undefined || stop === 'tool-pending') {
        out.push({ ...entry, status: 'skipped' })
        continue
      }
      const result = waitResultFor(
        stop,
        textOf(last, true),
        last.metadata?.eharness?.error?.message,
      )
      const status = await settleWait(parentSession, wait.waitId, result, {
        onParentRun: options.onParentRun,
        parentSessionId: parentSession.id,
        log,
      })
      out.push({ ...entry, status: status === 'busy' ? 'busy' : 'resolved' })
    } catch (error) {
      log.warn('subagent: reconciling a wait failed', {
        waitId: wait.waitId,
        error: errorText(error),
      })
      out.push({ ...entry, status: 'skipped' })
    }
  }
  return out
}

/** The framed first user message of a turn a launcher started with `send_message` (ADR-0041). */
function launcherFrame(e: TurnResult): ReturnType<typeof parseAgentFrame> {
  const first = (e.messages as unknown as MessageLike[]).find((m) => m.role === 'user')
  return first === undefined ? undefined : parseAgentFrame(textOf(first, false))
}

/** The report text of a finished turn: its answer, or why it did not finish. */
function reportBody(e: TurnResult): string {
  const text = finalText(e)
  return e.stop === 'complete' ? text : stoppedText(e.stop, text || (e.error?.message ?? ''))
}

/**
 * Child side of `'park'`: when a child's turn ends (not `tool-pending`), resolve the parent's wait
 * with its report. Returns the settle function; the first attempt is awaited, a busy parent (the
 * same instance still inside the turn that started the child) is retried in the background.
 */
export function createParkHook(options: {
  parentAgent: (() => AnyAgent) | undefined
  onParentRun: ((run: AnyRun, parentSessionId: string) => void) | undefined
  parentSession: ((sessionId: string) => SessionOptions | undefined) | undefined
  /** `'park'` messaging: the report of a turn started by the launcher's message goes back to it. */
  reportResumes: boolean
  /** Cap of a background report (default {@link AGENT_REPORT_MAX_CHARS}). */
  maxReportChars?: number
  /** Name of the `agent_output` tool, named in the hint of a cut report (none: no hint). */
  outputToolName?: string
  /** How the "waiting for the user" notice of a parked background child is delivered. */
  onPark?: 'step' | 'notice'
}): {
  start: (ctx: HarnessContext) => void
  end: (ctx: HarnessContext, e: TurnResult) => Promise<void>
} {
  const reportMax = Math.max(1, options.maxReportChars ?? AGENT_REPORT_MAX_CHARS)
  /** The launcher's session (callers checked that `parentAgent` is set). */
  const openParent = (sessionId: string): AnySession =>
    (options.parentAgent as () => AnyAgent)().session(
      sessionId,
      options.parentSession?.(sessionId) ?? {},
    ) as AnySession
  /**
   * A durable background child (ADR-0046) is marked in its own plugin state by the turn that
   * started it (the inbox key of `subagent-bg:<toolCallId>`), so every later turn end of that
   * session (also a `respond()` continuation, in any instance) knows to report to the parent.
   */
  const start = (ctx: HarnessContext): void => {
    const key = ctx.turn?.source?.key
    const toolCallId = ctx.session.parent?.toolCallId
    if (key !== undefined && toolCallId !== undefined && key === `${BACKGROUND_KEY}${toolCallId}`) {
      ctx.state.set(BACKGROUND_STATE, { toolCallId })
    }
  }
  /**
   * Whether the parent's call for `toolCallId` was answered with a cancellation or an interruption
   * (spec 11 §4.1 `onNewInput: 'deny'`, ADR-0014) while this park child kept running (ADR-0046).
   */
  const orphaned = async (
    ctx: HarnessContext,
    parentSession: AnySession,
    toolCallId: string,
  ): Promise<boolean> => {
    try {
      const stored = (await parentSession.messages({ limit: 100 })) as unknown as MessageLike[]
      for (const message of stored.toReversed()) {
        for (const part of message.parts as Array<{
          type: string
          toolCallId?: string
          state?: string
          errorText?: string
        }>) {
          if (part.toolCallId !== toolCallId || !part.type.startsWith('tool-')) continue
          if (part.state !== 'output-error') return false
          const text = part.errorText ?? ''
          return text === WAIT_CANCELLED_NEW_INPUT || text.startsWith('Interrupted:')
        }
      }
    } catch (error) {
      ctx.log.warn('subagent: could not read the parent call', { error: errorText(error) })
    }
    return false
  }
  /** The report (or the waiting notice) of a durable background child, into its launcher. */
  const reportBackground = async (
    ctx: HarnessContext,
    e: TurnResult,
    parent: { sessionId: string },
    cancelled = false,
  ): Promise<void> => {
    if (options.parentAgent === undefined) return
    const identity = ctx.session.parent as
      | { agent?: string; name?: string; description?: string }
      | undefined
    const agent = identity?.agent ?? 'agent'
    const who = `${ctx.session.id}${identity?.name === undefined ? '' : ` "${identity.name}"`}`
    const what = `(${agent}${identity?.description === undefined ? '' : `: ${identity.description}`})`
    const waiting = e.stop === 'tool-pending'
    const status = waiting ? 'waiting' : statusOfStop(e.stop)
    const body = reportBody(e)
    const head = waiting
      ? `Background subagent ${who} ${what} is waiting for the user to answer a permission request or a question. It continues once that is answered; its report arrives when it finishes.`
      : `Background subagent ${who} ${what} ${
          status === 'completed'
            ? 'finished'
            : status === 'stopped'
              ? 'was stopped'
              : status === 'interrupted'
                ? 'was interrupted'
                : 'failed'
        }${cancelled ? ' after its call was cancelled' : ''}.\n\n${
          reportOf(
            neutralizeTags(body, ['agent-message']),
            reportMax,
            options.outputToolName === undefined
              ? undefined
              : `read the full report with ${options.outputToolName}({ id: "${ctx.session.id}" })`,
          ) || '(no report)'
        }`
    await deliverReport(
      openParent(parent.sessionId),
      {
        text: head,
        data: {
          sessionId: ctx.session.id,
          agent,
          status,
          taskId: ctx.session.id,
          turnId: e.turnId,
          ...(identity?.name === undefined ? {} : { name: identity.name }),
        },
        key: reportKey(ctx.session.id, waiting ? `waiting:${e.turnId}` : e.turnId),
        wake: !waiting,
        // a park notice in 'notice' mode is only stored: it never gives a running parent an extra step
        ...(waiting && options.onPark === 'notice' ? { deliver: 'next-turn' as const } : {}),
      },
      ctx.log,
    )
  }
  /**
   * A turn that a launcher's `send_message` started (a framed `to="…"` user message, ADR-0041):
   * enqueue the report into the launcher's session through storage, so it works from any instance.
   */
  const reportResume = async (
    ctx: HarnessContext,
    e: TurnResult,
    parent: { sessionId: string },
  ): Promise<void> => {
    if (!options.reportResumes || options.parentAgent === undefined) return
    const frame = launcherFrame(e)
    if (frame === undefined || frame.relation !== 'launcher' || frame.to === undefined) return
    const status = e.stop === 'complete' ? 'completed' : 'failed'
    const body = reportBody(e)
    const label = frame.to === ctx.session.id ? undefined : frame.to
    const who = label === undefined ? ctx.session.id : `"${label}"`
    await deliverReport(
      openParent(parent.sessionId),
      {
        text: `Resumed subagent ${who} ${status === 'completed' ? 'finished' : 'failed'}.\n\n${reportOf(neutralizeTags(body, ['agent-message']), AGENT_REPORT_MAX_CHARS) || '(no report)'}`,
        data: {
          sessionId: ctx.session.id,
          status,
          turnId: e.turnId,
          ...(label === undefined ? {} : { name: label }),
        },
        key: reportKey(ctx.session.id, e.turnId),
        wake: true,
      },
      ctx.log,
    )
  }
  const end = async (ctx: HarnessContext, e: TurnResult): Promise<void> => {
    const parent = ctx.session.parent
    if (parent?.toolCallId === undefined) return
    if (options.parentAgent === undefined) return
    // a long-run chunk end is a checkpoint, not the end of the job (spec 33 §3)
    if (isLongRunCheckpoint(e.stop)) return
    if (ctx.state.get(BACKGROUND_STATE) !== undefined) {
      const frame = launcherFrame(e)
      // a turn the launcher started with send_message reports as a resume (ADR-0041)
      if (frame?.relation === 'launcher' && frame.to !== undefined && e.stop !== 'tool-pending') {
        await reportResume(ctx, e, parent)
      } else await reportBackground(ctx, e, parent)
      return
    }
    const parentSession = openParent(parent.sessionId)
    if (e.stop === 'tool-pending') {
      // a child whose parent call was cancelled keeps running: tell the parent it is waiting
      if (await orphaned(ctx, parentSession, parent.toolCallId)) {
        ctx.state.set(BACKGROUND_STATE, { toolCallId: parent.toolCallId })
        await reportBackground(ctx, e, parent, true)
      }
      return
    }
    const waitId = subagentWaitId(parent.toolCallId)
    let waits: Awaited<ReturnType<AnySession['pendingWaits']>>
    try {
      waits = await parentSession.pendingWaits()
    } catch (error) {
      ctx.log.warn('subagent: could not read the parent waits', { error: errorText(error) })
      return
    }
    const wait = waits.find((w) => w.waitId === waitId)
    // not a parked child (inline, policy, background), or already resolved: maybe a resume
    if (wait === undefined || wait.result !== undefined) {
      const frame = launcherFrame(e)
      const resume = frame?.relation === 'launcher' && frame.to !== undefined
      // the parent's call was cancelled (new input) or interrupted while this child kept running:
      // report like a background child, once (the marker makes later turns report as well)
      if (!resume && (await orphaned(ctx, parentSession, parent.toolCallId))) {
        ctx.state.set(BACKGROUND_STATE, { toolCallId: parent.toolCallId })
        await reportBackground(ctx, e, parent, true)
        return
      }
      await reportResume(ctx, e, parent)
      return
    }
    const result = waitResultFor(e.stop, finalText(e), e.error?.message)
    const settle = (): Promise<'done' | 'busy'> =>
      settleWait(parentSession, waitId, result, {
        onParentRun: options.onParentRun,
        parentSessionId: parent.sessionId,
        log: ctx.log,
      })
    if ((await settle()) === 'busy') {
      // the parent turn that started this child is still running here: retry after it ended
      void (async () => {
        for (let delay = 20, tries = 0; tries < 60; tries++, delay = Math.min(delay * 2, 1000)) {
          await sleep(delay)
          if ((await settle()) === 'done') return
        }
        ctx.log.warn('subagent: the parent stayed busy; its wait was not resolved', {
          parent: parent.sessionId,
          waitId,
        })
      })()
    }
  }
  return { start, end }
}

/**
 * Plugin for agents that run as children of a `'park'` parent: its `turn.end` hook resolves the
 * parent's wait when the child's turn completes (in any instance). `parent` returns the agent that
 * owns the parent sessions; it is a function so two agents can reference each other.
 *
 * @example
 * ```ts
 * const worker = defineHarnessAgent({ ..., plugins: [subagentChild({ parent: () => main })] })
 * const main = defineHarnessAgent({ ..., plugins: [subagent({ agents: { worker: { agent: worker, description: '…' } }, approvals: 'park' })] })
 * ```
 */
export function subagentChild(options: {
  parent: () => AnyAgent
  onParentRun?: (run: AnyRun, parentSessionId: string) => void
  /** Session options (`lock`, `runtime`, `storage`) for the parent sessions this plugin opens. */
  parentSession?: (sessionId: string) => Omit<SessionOptions, 'parent'> | undefined
  /** Cap of the report a finished durable background child sends (default 16 000 characters). */
  maxReportChars?: number
  /** Name of the `agent_output` tool of the parent, named in the hint of a cut report. */
  outputToolName?: string
  /** How the notice that this child waits for a person reaches the parent (see `SubagentOptions.onPark`). Default `'step'`. */
  onPark?: 'step' | 'notice'
}): HarnessPlugin<'subagent-child'> {
  const hook = createParkHook({
    parentAgent: options.parent,
    onParentRun: options.onParentRun,
    parentSession: options.parentSession,
    reportResumes: true,
    ...(options.maxReportChars === undefined ? {} : { maxReportChars: options.maxReportChars }),
    ...(options.outputToolName === undefined ? {} : { outputToolName: options.outputToolName }),
    ...(options.onPark === undefined ? {} : { onPark: options.onPark }),
  })
  return definePlugin({
    name: 'subagent-child',
    session: () =>
      ({ hooks: { 'turn.start': hook.start, 'turn.end': hook.end } }) as SessionContribution,
  }) as HarnessPlugin<'subagent-child'>
}

/**
 * The child sessions of `session` (recursively) that wait for an approval or a client tool answer:
 * what a web UI lists so the user can answer them with `childSession.respond(...)`. Reads stored
 * state; works in any instance. `open` is the agent that runs the children (children of several
 * agents: a function that opens the child session on the right agent).
 */
export async function pendingSubagentApprovals(
  session: AnySession | SessionPeek,
  open: AnyAgent | ((childSessionId: string) => AnySession | SessionPeek),
): Promise<
  Array<{
    sessionId: string
    parentSessionId: string
    pending: PendingState
    agent?: string
    name?: string
    description?: string
  }>
> {
  const out: Array<{
    sessionId: string
    parentSessionId: string
    pending: PendingState
    agent?: string
    name?: string
    description?: string
  }> = []
  const walk = async (
    parent: { id: string; children(): Promise<ChildSessionInfo[]> },
    depth: number,
  ): Promise<void> => {
    if (depth > 8) return
    for (const info of await parent.children()) {
      // an agent opens a read handle (peek): listing never resumes a parked child
      const child: SessionPeek | AnySession =
        typeof open === 'function' ? open(info.sessionId) : open.peek(info.sessionId)
      const stats = await child.stats()
      if (stats.pending !== null) {
        out.push({
          sessionId: info.sessionId,
          parentSessionId: parent.id,
          pending: stats.pending,
          ...(info.agent === undefined ? {} : { agent: info.agent }),
          ...(info.name === undefined ? {} : { name: info.name }),
          ...(info.description === undefined ? {} : { description: info.description }),
        })
      }
      await walk(child, depth + 1)
    }
  }
  await walk(session, 0)
  return out
}
