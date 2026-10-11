/**
 * The execution modes of a child (spec 20 §3): a foreground `agent` call that streams progress
 * (inline / policy), a detached background child (also the resume of a finished child), the
 * durable background start and the `'park'` external tool. The foreground, background and park
 * modes run inside {@link withChildLifecycle}.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { type FileUIPart, type FlexibleSchema, type JSONValue, tool } from 'ai'
import {
  errorText,
  externalTool,
  neutralizeTags,
  type ParentInfo,
  type StepEndEvent,
  type ToolInput,
  type TurnResult,
} from '../index.ts'
import {
  chargeUsage,
  closeChild,
  drain,
  driveChild,
  finalText,
  inspect,
  readMessages,
  SUBAGENT_BACKGROUNDED_PREFIX,
  sleep,
  summarizePending,
} from './child-run.ts'
import { addEntry, finishEntry, rebuildEntries, rebuildPark } from './entries.ts'
import type { Reporter, Scope } from './env.ts'
import { claimSlot, claimSpawn } from './env.ts'
import { childInput, resolveChildFiles } from './files.ts'
import { withChildLifecycle } from './lifecycle.ts'
import { type AddUsage, type AgentEntry, type AgentSender, nameProblem } from './messaging.ts'
import { type MessageLike, reportOf, stoppedText, textOf } from './report.ts'
import { reporterOf } from './routing.ts'
import {
  type AgentInput,
  type AnyRun,
  type AnySession,
  BACKGROUND_KEY,
  type Ctx,
  type SubagentDefinition,
  type SubagentProgress,
  type SubagentRunData,
} from './types.ts'

/** Does the child's turn result read as a success? */
const reportFor = (
  result: TurnResult,
  text: string,
): { status: 'completed' | 'failed'; text: string } =>
  result.stop === 'complete'
    ? { status: 'completed', text }
    : { status: 'failed', text: stoppedText(result.stop, text) }

/** The completion of a background child: registry, run marker and the report to the reader. */
function backgroundFinisher(
  scope: Scope,
  a: {
    taskId: string
    agentName: string
    label: string
    sessionId: string
    marker: (status: SubagentRunData['status']) => void
    entry?: AgentEntry | undefined
    name?: string
    /** Where the report goes. Default: the session that started the child. */
    report?: Reporter
    resumed?: boolean
  },
): (status: 'completed' | 'failed', text: string) => Promise<void> {
  const { ctx, registry, env } = scope
  const report = a.report ?? reporterOf(ctx)
  return async (status, text) => {
    const stopped = registry.stopped(a.taskId)
    registry.complete(a.taskId, status)
    finishEntry(a.entry, stopped ? 'stopped' : status)
    a.marker(stopped ? 'stopped' : status)
    const outcome = stopped ? 'stopped' : status
    const who = `${a.taskId}${a.name === undefined ? '' : ` "${a.name}"`}`
    const head = `${a.resumed === true ? 'Resumed subagent' : 'Background subagent'} ${who} (${a.agentName}: ${a.label}) ${
      stopped ? 'was stopped' : status === 'completed' ? 'finished' : 'failed'
    }.`
    const hint = env.outputEnabled
      ? `read the full report with ${env.outputToolName}({ id: "${a.taskId}" })`
      : undefined
    try {
      await report(
        `${head}\n\n${reportOf(neutralizeTags(text, ['agent-message']), env.reportMax, hint) || '(no report)'}`,
        {
          sessionId: a.sessionId,
          agent: a.agentName,
          status: outcome,
          taskId: a.taskId,
          ...(a.name === undefined ? {} : { name: a.name }),
        },
      )
    } catch (error) {
      // the receiving session may be closed by now
      ctx.log.warn('subagent: could not deliver a background report', { error: errorText(error) })
    }
  }
}

/** Start a new turn on a finished child (ADR-0038); resolves to the task id for the sender. */
export async function resumeEntry(
  scope: Scope,
  entry: AgentEntry,
  text: string,
  sender: AgentSender,
): Promise<string> {
  const def = scope.defs()[entry.agent]
  if (def === undefined) {
    return `ERROR: the agent type "${entry.agent}" is not available any more; it cannot be resumed.`
  }
  entry.modelStopped = false
  return launch({
    scope,
    def,
    entry,
    agentName: entry.agent,
    label: entry.description,
    prompt: text,
    sessionId: entry.childSessionId,
    parentInfo: entry.parentInfo,
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(sender.kind === 'agent'
      ? {
          report: sender.report,
          ...(sender.addUsage === undefined ? {} : { addUsage: sender.addUsage }),
        }
      : {}),
    resumed: true,
  })
}

// ─── background: a detached turn, a task of the registry ────────────────────────────────

/** Start a child detached from the calling turn; returns the text for the model. */
function startBackground(
  scope: Scope,
  a: {
    toolCallId: string
    def: SubagentDefinition
    agentName: string
    label: string
    prompt: string
    files?: FileUIPart[]
    sessionId: string
    parentInfo: ParentInfo
    name: string | undefined
  },
): string {
  const { name, ...rest } = a
  const { agentName, label, sessionId } = rest
  const entry = addEntry(scope, {
    childSessionId: sessionId,
    agent: agentName,
    description: label,
    parentInfo: a.parentInfo,
    ...(name === undefined ? {} : { name }),
  })
  const taskId = launch({
    scope,
    entry,
    ...rest,
    ...(name === undefined ? {} : { name }),
    resumed: false,
  })
  return `Started background subagent ${taskId}${name === undefined ? '' : ` "${name}"`} (${agentName}): ${label}. You will be notified when it finishes.`
}

/**
 * Run a child turn detached (a `run_in_background` start, or a resume of a finished child) as a
 * task of the registry. Returns the task id at once.
 */
function launch(a: {
  scope: Scope
  def: SubagentDefinition
  entry: AgentEntry | undefined
  agentName: string
  label: string
  name?: string
  prompt: string
  files?: FileUIPart[]
  sessionId: string
  parentInfo: ParentInfo
  /** Run marker (first start only). */
  toolCallId?: string
  /** Existing task id: the task runs again. */
  taskId?: string
  report?: Reporter
  addUsage?: AddUsage
  resumed: boolean
}): string {
  const { scope, def, entry, agentName, label, sessionId, parentInfo } = a
  const { ctx, registry, env } = scope
  const ac = new AbortController()
  const stop = (): void => {
    if (entry !== undefined) entry.status = 'stopped'
    ac.abort('stopped')
  }
  let taskId: string
  if (a.taskId !== undefined && registry.get(a.taskId) !== undefined) {
    taskId = a.taskId
    registry.restart(taskId, stop)
  } else {
    taskId = registry.add({
      ...(a.taskId === undefined ? {} : { id: a.taskId }),
      agent: agentName,
      description: label,
      ...(a.name === undefined ? {} : { name: a.name }),
      childSessionId: sessionId,
      stop,
    })
  }
  if (entry !== undefined) {
    entry.taskId = taskId
    entry.status = 'running'
    entry.startedAt = Date.now()
  }
  /** The persisted marker, while the starting turn still streams (a later turn cannot amend it). */
  const marker = (status: SubagentRunData['status']): void => {
    if (a.toolCallId !== undefined && ctx.stream.active && ctx.turn?.id === parentInfo.turnId) {
      ctx.stream.data(
        'run',
        {
          toolCallId: a.toolCallId,
          sessionId,
          agent: agentName,
          status,
          taskId,
          ...(a.name === undefined ? {} : { name: a.name }),
        },
        { id: a.toolCallId },
      )
    }
  }
  marker('running')
  const finish = backgroundFinisher(scope, {
    taskId,
    agentName,
    label,
    sessionId,
    marker,
    entry,
    resumed: a.resumed,
    ...(a.name === undefined ? {} : { name: a.name }),
    ...(a.report === undefined ? {} : { report: a.report }),
  })
  void withChildLifecycle(
    {
      scope,
      def,
      sessionId,
      entry,
      ac,
      onRefused: () => finish('failed', 'aborted before it started'),
    },
    async (lease) => {
      try {
        const child = lease.open(
          env.childOptions(
            {
              parentSessionId: parentInfo.sessionId,
              agent: agentName,
              ...(a.name === undefined ? {} : { name: a.name }),
              depth: parentInfo.depth,
            },
            { parent: parentInfo, ...env.directoryOptions(scope.dir) },
          ),
        )
        const run = child.send(childInput(a.prompt, a.files), {
          abortSignal: ac.signal,
          ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
        }) as AnyRun
        const consumers: Promise<void>[] = []
        const result = await driveChild(run, {
          session: child,
          agent: agentName,
          options: env.options,
          signal: ac.signal,
          onRun: (r) => {
            consumers.push(
              readMessages(r, (m) =>
                registry.setTail(taskId, textOf(m, true) || inspect(m).lastTool || ''),
              ),
            )
          },
        })
        await Promise.all(consumers)
        const charge: AddUsage =
          a.addUsage ?? ((usage, source) => chargeUsage(ctx.turn, usage, source))
        charge(result.usage, `subagent:${agentName}`)
        const done = reportFor(result, finalText(result))
        await finish(done.status, done.text)
      } catch (error) {
        await finish('failed', errorText(error))
      }
    },
  )
  return taskId
}

// ─── foreground: an ordinary tool that runs the child and streams progress ──────────────

/** The `agent` tool of `approvals: 'inline' | 'policy'`. */
export function runTool(scope: Scope, description: string, inputSchema: unknown): ToolInput {
  const { env, ctx, registry, depth } = scope
  const { options, backgroundOn, backgroundDefault, backgroundInChildren } = env
  return tool({
    description,
    inputSchema: inputSchema as FlexibleSchema<AgentInput>,
    async *execute(
      { subagent_type, description: label, prompt, files: fileRefs, run_in_background, name },
      { toolCallId, abortSignal: toolSignal },
    ): AsyncGenerator<SubagentProgress | string, void, undefined> {
      const abortSignal = toolSignal ?? new AbortController().signal
      const defs = scope.defs()
      const def = defs[subagent_type]
      if (def === undefined) {
        yield `ERROR: unknown subagent_type "${subagent_type}". Available: ${Object.keys(defs).join(', ')}`
        return
      }
      const turn = ctx.turn
      if (turn === undefined) {
        yield 'ERROR: subagents can only be started inside a turn.'
        return
      }
      let files: FileUIPart[] = []
      if (options.files !== undefined) {
        const resolved = await resolveChildFiles(options.files, fileRefs, {
          parentSessionId: ctx.session.id,
          agent: subagent_type,
          signal: abortSignal,
        })
        if ('error' in resolved) {
          yield resolved.error
          return
        }
        files = resolved.files
      }
      const sessionId = env.childIdOf(ctx.session.id, toolCallId)
      if (options.maxChildren !== undefined) {
        const refused = await claimSpawn(scope, sessionId)
        if (refused !== undefined) {
          yield refused
          return
        }
      }
      const dir = scope.dir
      if (dir !== undefined && name !== undefined) {
        await rebuildEntries(scope)
        const problem = nameProblem(dir, name)
        if (problem !== undefined) {
          yield problem
          return
        }
      }
      const parentInfo: ParentInfo = {
        sessionId: ctx.session.id,
        turnId: turn.id,
        toolCallId,
        depth: depth + 1,
        agent: subagent_type,
        description: label,
        ...(name === undefined ? {} : { name }),
      }
      const canDetach = backgroundOn && (ctx.session.parent === undefined || backgroundInChildren)
      if ((run_in_background ?? backgroundDefault) && canDetach) {
        yield startBackground(scope, {
          toolCallId,
          def,
          agentName: subagent_type,
          label,
          prompt,
          files,
          sessionId,
          parentInfo,
          name,
        })
        return
      }
      const entry = addEntry(scope, {
        childSessionId: sessionId,
        agent: subagent_type,
        description: label,
        parentInfo,
        ...(name === undefined ? {} : { name }),
      })
      const progress = (over: Partial<SubagentProgress>): SubagentProgress => ({
        status: 'running',
        agent: subagent_type,
        description: label,
        sessionId,
        steps: 0,
        text: '',
        ...over,
      })
      const runData = (status: SubagentRunData['status']): SubagentRunData => ({
        toolCallId,
        sessionId,
        agent: subagent_type,
        status,
        ...(name === undefined ? {} : { name }),
        ...(entry?.taskId === undefined ? {} : { taskId: entry.taskId }),
      })
      const marker = (status: SubagentRunData['status']): void => {
        if (ctx.stream.active) ctx.stream.data('run', runData(status), { id: toolCallId })
      }
      // latest-value mailbox between the stream consumers / the lifecycle and this generator
      let latest = progress({})
      let dirty = true
      /** The child's turns and stream consumers are done. */
      let finished = false
      /** The lifecycle ended: slot released, session closed. */
      let settled = false
      let wake: (() => void) | undefined
      const notify = (): void => {
        dirty = true
        wake?.()
      }
      let detachedId: string | undefined
      let outcome = undefined as { progress: SubagentProgress; text: string } | undefined
      let stepsBefore = 0
      let stepsNow = 0
      let lastMessage: MessageLike | undefined
      const consumers: Promise<void>[] = []
      const consume = async (run: AnyRun): Promise<void> => {
        stepsBefore += stepsNow
        stepsNow = 0
        await readMessages(run, (m) => {
          lastMessage = m
          const info = inspect(m)
          stepsNow = info.steps
          latest = progress({
            steps: stepsBefore + info.steps,
            lastTool: info.lastTool ?? latest.lastTool,
            text: textOf(m, true),
          })
          notify()
          if (detachedId !== undefined) {
            registry.setTail(detachedId, textOf(m, true) || info.lastTool || '')
          }
        })
      }
      const failedOutcome = (text: string, over: Partial<SubagentProgress> = {}): void => {
        finishEntry(entry, 'failed')
        marker('failed')
        outcome = { progress: progress({ status: 'failed', ...over }), text }
      }
      // the child's own abort: follows the tool call until the user moves it to the background
      const childAc = new AbortController()
      marker('running')
      yield progress({ text: 'Waiting for a free subagent slot…' })
      /** The completion of a child the user moved to the background. */
      const detachedFinish = (status: 'completed' | 'failed', text: string): Promise<void> =>
        backgroundFinisher(scope, {
          taskId: detachedId as string,
          agentName: subagent_type,
          label,
          sessionId,
          marker: (st) => {
            if (ctx.stream.active && ctx.turn?.id === parentInfo.turnId) {
              ctx.stream.data('run', runData(st), { id: toolCallId })
            }
          },
          entry,
          ...(name === undefined ? {} : { name }),
        })(status, text)
      const lifecycle = withChildLifecycle(
        {
          scope,
          def,
          sessionId,
          entry,
          ac: childAc,
          follow: abortSignal,
          onRefused: () => failedOutcome('ERROR: subagent was aborted before it started.'),
        },
        async (lease) => {
          try {
            const child = lease.open(
              env.childOptions(
                {
                  parentSessionId: ctx.session.id,
                  agent: subagent_type,
                  ...(name === undefined ? {} : { name }),
                  depth: depth + 1,
                },
                { parent: parentInfo, ...env.directoryOptions(scope.dir) },
              ),
            )
            const run = child.send(childInput(prompt, files), {
              abortSignal: childAc.signal,
              ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
            }) as AnyRun
            const driven = driveChild(run, {
              session: child,
              agent: subagent_type,
              options,
              signal: childAc.signal,
              onRun: (r) => {
                consumers.push(consume(r))
              },
            }).finally(async () => {
              await Promise.all(consumers)
              finished = true
              notify()
            })
            // observed below; this keeps an early exit of the lifecycle from leaving it unhandled
            driven.catch(() => {})
            if (canDetach) {
              registry.foreground.set(toolCallId, () => {
                if (detachedId !== undefined || finished) return undefined
                lease.unfollow()
                detachedId = registry.add({
                  agent: subagent_type,
                  description: label,
                  ...(name === undefined ? {} : { name }),
                  childSessionId: sessionId,
                  stop: () => {
                    if (entry !== undefined) entry.status = 'stopped'
                    childAc.abort('stopped')
                  },
                })
                if (entry !== undefined) entry.taskId = detachedId
                notify()
                return detachedId
              })
            }
            const result = await driven
            if (detachedId !== undefined) {
              // moved to the background by the user: this lifecycle now runs as a task
              chargeUsage(ctx.turn, result.usage, `subagent:${subagent_type}`)
              const done = reportFor(result, finalText(result) || textOf(lastMessage, true))
              await detachedFinish(done.status, done.text)
              return
            }
            chargeUsage(turn, result.usage, `subagent:${subagent_type}`)
            const text = finalText(result) || textOf(lastMessage, true) || latest.text
            const complete = result.stop === 'complete'
            finishEntry(entry, complete ? 'completed' : 'failed')
            marker(complete ? 'completed' : 'failed')
            outcome = {
              progress: progress({
                status: complete ? 'completed' : 'failed',
                steps: latest.steps || result.steps,
                lastTool: latest.lastTool,
                text,
              }),
              text: complete
                ? text || '(the subagent returned no text)'
                : result.stop === 'error'
                  ? `ERROR: subagent failed${result.error === undefined ? '' : `: ${result.error.message}`}`
                  : stoppedText(result.stop, text),
            }
          } catch (error) {
            if (detachedId !== undefined) await detachedFinish('failed', errorText(error))
            else
              failedOutcome(`ERROR: subagent failed: ${errorText(error)}`, {
                text: errorText(error),
              })
          }
        },
      )
        .catch((error) =>
          ctx.log.warn('subagent: a foreground child ended badly', { error: errorText(error) }),
        )
        .finally(() => {
          settled = true
          notify()
        })
      try {
        while ((!(finished || settled) || dirty) && detachedId === undefined) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve
              if (dirty || finished || settled) resolve()
            })
            wake = undefined
            continue
          }
          dirty = false
          yield latest
          if (!finished) await sleep(100)
        }
        if (detachedId !== undefined) {
          const soFar = latest.text || latest.lastTool || ''
          yield progress({ status: 'running', text: 'Moved to the background.' })
          yield `${SUBAGENT_BACKGROUNDED_PREFIX} ${detachedId} (${subagent_type}): ${label}, by the user.${
            soFar === '' ? '' : ` Progress so far: ${reportOf(soFar.slice(-1000), 1000)}`
          } You will be notified when it finishes.`
          return
        }
        await lifecycle
        if (outcome !== undefined) {
          const { progress: last, text } = outcome
          yield last
          yield text
        }
      } finally {
        registry.foreground.delete(toolCallId)
        // an early exit of the consumer: end the child, the lifecycle then cleans up
        if (!settled && detachedId === undefined) childAc.abort('tool call ended')
      }
    },
  })
}

// ─── park: an external tool whose start runs the child's first turn ─────────────────────

/**
 * `'park'` + background (ADR-0046): start the child's first turn through its durable inbox and
 * answer the parent's call at once. Idempotent by the inbox key: a redispatched `start` neither
 * sends the prompt twice nor re-registers the child. The child handle stays open (it drains its
 * own inbox) unless the start fails.
 */
async function startDurable(a: {
  scope: Scope
  def: SubagentDefinition
  toolCallId: string
  sessionId: string
  agentName: string
  label: string
  prompt: string
  files: FileUIPart[]
  name: string | undefined
  parentInfo: ParentInfo
  base: { childSessionId: string; agent: string; description: string }
}): Promise<{
  correlationId: string
  payload: JSONValue
  timeoutAt: number
  onTimeout: { output: string } | { errorText: string }
}> {
  const { scope, def, sessionId, agentName, label, name } = a
  const fail = (errorText: string) => ({
    correlationId: sessionId,
    payload: { ...a.base, status: 'failed', background: true } as JSONValue,
    timeoutAt: Date.now(),
    onTimeout: { errorText },
  })
  let keepOpen = false
  try {
    const child = def.agent.session(
      sessionId,
      scope.env.childOptions(
        {
          parentSessionId: scope.ctx.session.id,
          agent: agentName,
          ...(name === undefined ? {} : { name }),
          depth: a.parentInfo.depth,
        },
        { parent: a.parentInfo },
      ),
    ) as AnySession
    // opening links the child: it registers in the parent's child index (spec 05 §13)
    await child.ready()
    const stored = await child.messages({ limit: 1 })
    if (stored.length === 0) {
      const refused = await claimSlot(scope)
      if (refused !== undefined) return fail(refused)
      await child.enqueue(childInput(a.prompt, a.files), {
        mode: 'queue',
        id: `${BACKGROUND_KEY}${a.toolCallId}`,
      })
    }
    keepOpen = true
  } catch (error) {
    return fail(`ERROR: could not start the subagent: ${errorText(error)}`)
  } finally {
    if (!keepOpen) await closeChild(def, sessionId)
  }
  const id = name === undefined ? sessionId : `${sessionId} "${name}"`
  return {
    correlationId: sessionId,
    payload: { ...a.base, status: 'running', background: true } as JSONValue,
    timeoutAt: Date.now(),
    onTimeout: {
      output: `Started background subagent ${id} (${agentName}): ${label}. You will be notified when it finishes.`,
    },
  }
}

/** Resolve at once with an error text (through the wait's own timeout path). */
const failNow = (errorText: string): { timeoutAt: number; onTimeout: { errorText: string } } => ({
  timeoutAt: Date.now(),
  onTimeout: { errorText },
})

/** The `agent` tool of `approvals: 'park'`. */
export function parkTool(
  scope: Scope,
  description: string,
  inputSchema: unknown,
  canBackground: boolean,
): ToolInput {
  const { env, ctx, depth } = scope
  const { options, messaging } = env
  return externalTool({
    description,
    inputSchema: inputSchema as FlexibleSchema<AgentInput>,
    ...(options.parkTimeoutMs === undefined ? {} : { timeoutMs: options.parkTimeoutMs }),
    async start(input, event) {
      const { subagent_type, description: label, prompt, name } = input
      const defs = scope.defs()
      const def = defs[subagent_type]
      if (def === undefined) {
        return failNow(
          `ERROR: unknown subagent_type "${subagent_type}". Available: ${Object.keys(defs).join(', ')}`,
        )
      }
      const turn = ctx.turn
      if (turn === undefined) return failNow('ERROR: subagents can only be started inside a turn.')
      let files: FileUIPart[] = []
      if (options.files !== undefined) {
        const resolved = await resolveChildFiles(options.files, input.files, {
          parentSessionId: ctx.session.id,
          agent: subagent_type,
          signal: event.abortSignal,
        })
        if ('error' in resolved) return failNow(resolved.error)
        files = resolved.files
      }
      const sessionId = env.childIdOf(ctx.session.id, event.toolCallId)
      const refused =
        options.maxChildren === undefined ? undefined : await claimSpawn(scope, sessionId)
      if (refused !== undefined) return failNow(refused)
      const parentInfo: ParentInfo = {
        sessionId: ctx.session.id,
        turnId: turn.id,
        toolCallId: event.toolCallId,
        depth: depth + 1,
        agent: subagent_type,
        description: label,
        ...(name === undefined ? {} : { name }),
      }
      if (messaging && scope.dir !== undefined) {
        // the directory comes from storage: names are unique across instances and restarts
        await rebuildPark(scope, true)
        const own = scope.dir.entries.get(sessionId)
        if (name !== undefined && own?.name !== name) {
          const problem = nameProblem(scope.dir, name)
          if (problem !== undefined) return failNow(problem)
        }
        if (own === undefined) {
          addEntry(scope, {
            childSessionId: sessionId,
            agent: subagent_type,
            description: label,
            durable: true,
            parentInfo,
            ...(name === undefined ? {} : { name }),
          })
        }
      }
      const base = { childSessionId: sessionId, agent: subagent_type, description: label }
      if (env.isBackgroundCall(input, canBackground)) {
        return startDurable({
          scope,
          def,
          toolCallId: event.toolCallId,
          sessionId,
          agentName: subagent_type,
          label,
          prompt,
          files,
          name,
          parentInfo,
          base,
        })
      }
      // a park child outlives this instance: it follows the wait, not the parent session
      return await withChildLifecycle(
        {
          scope,
          def,
          sessionId,
          follow: event.abortSignal,
          followParent: false,
          onRefused: () => failNow('ERROR: subagent was aborted before it started.'),
        },
        async (lease) => {
          try {
            const child = lease.open(
              env.childOptions(
                {
                  parentSessionId: ctx.session.id,
                  agent: subagent_type,
                  ...(name === undefined ? {} : { name }),
                  depth: depth + 1,
                },
                { parent: parentInfo },
              ),
            )
            // idempotent by waitId: a redispatched start must not send the prompt twice
            const stored = await child.messages()
            if (stored.length > 0) {
              const stats = await child.stats()
              if (stats.pending !== null || stats.activeTurn !== null) {
                return {
                  correlationId: sessionId,
                  payload: {
                    ...base,
                    status: 'waiting',
                    ...(stats.pending === null ? {} : { pending: summarizePending(stats.pending) }),
                  } as JSONValue,
                }
              }
              const last = (stored as unknown as MessageLike[]).findLast(
                (m) => m.role === 'assistant',
              )
              const text = textOf(last, true)
              return {
                correlationId: sessionId,
                timeoutAt: Date.now(),
                onTimeout: { output: text === '' ? '(the subagent returned no text)' : text },
              }
            }
            const run = child.send(childInput(prompt, files), {
              abortSignal: lease.ac.signal,
              ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
            }) as AnyRun
            drain(run)
            const result = (await run.result) as TurnResult
            chargeUsage(turn, result.usage, `subagent:${subagent_type}`)
            if (result.stop === 'tool-pending' && result.pending !== undefined) {
              return {
                correlationId: sessionId,
                payload: {
                  ...base,
                  status: 'waiting',
                  pending: summarizePending(result.pending),
                } as JSONValue,
              }
            }
            // finished already: the child's turn.end hook resolves the wait once this turn ended
            return {
              correlationId: sessionId,
              payload: { ...base, status: result.stop === 'complete' ? 'completed' : 'failed' },
            }
          } catch (error) {
            return failNow(`ERROR: subagent failed: ${errorText(error)}`)
          }
        },
      )
    },
  })
}

/** The run marker of every `agent` call of a step, written while the step still streams. */
export function parkMarkers(
  scope: Scope,
  defs: Record<string, SubagentDefinition>,
  canBackground: boolean,
): (hctx: Ctx, e: StepEndEvent) => void {
  const { env, ctx } = scope
  return (hctx, e) => {
    if (!hctx.stream.active) return
    for (const call of e.toolCalls) {
      if (call.toolName !== env.toolName) continue
      const input = call.input as Partial<AgentInput> | undefined
      if (input?.subagent_type === undefined || defs[input.subagent_type] === undefined) continue
      hctx.stream.data(
        'run',
        {
          toolCallId: call.toolCallId,
          sessionId: env.childIdOf(ctx.session.id, call.toolCallId),
          agent: input.subagent_type,
          status: 'running',
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(env.isBackgroundCall(input, canBackground) ? { background: true } : {}),
        },
        { id: call.toolCallId },
      )
    }
  }
}
