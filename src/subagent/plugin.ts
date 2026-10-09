/**
 * The `subagents()` plugin (spec 20): the `agent` tool, which runs a subagent as a child session.
 *
 * Built only with the public core API (ADR-0008). Three approval strategies for the child
 * (ADR-0034, ADR-0035): `'inline'` (answered in process), `'park'` (the parent parks as an
 * external wait; the answer arrives through the child session, from any instance) and `'policy'`
 * (answered automatically).
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { type FlexibleSchema, type JSONValue, readUIMessageStream, tool } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartDef,
  defineDataPart,
  definePlugin,
  externalTool,
  type HarnessAgent,
  type HarnessContext,
  type HarnessPlugin,
  type HarnessRun,
  type HarnessSession,
  isHarnessError,
  type PendingState,
  type SessionContribution,
  type ToolInput,
  type TurnResult,
} from '../index.ts'

/** Default tool name. */
export const SUBAGENT_TOOL = 'agent'

/** Denial reason of a child approval under `approvals: 'policy'` with `policy: 'deny'`. */
export const SUBAGENT_NO_USER =
  'No user is available; this action is not allowed in autonomous mode.'

/** Error text of a client tool call the child cannot get answered (policy mode, no answer). */
export const SUBAGENT_NO_CLIENT =
  'No user is available to answer this call. Continue without it or choose another approach.'

/** Text of a bare denial from an `answer` callback. */
export const SUBAGENT_DENIED = 'Denied by the user.'

/** Cap of the report injected into the parent when a background child finishes. */
export const SUBAGENT_BACKGROUND_REPORT_CHARS = 4000

// biome-ignore lint/suspicious/noExplicitAny: agents of different configs share one loose type
type AnyAgent = HarnessAgent<any>
// biome-ignore lint/suspicious/noExplicitAny: a session of a loosely typed agent
type AnySession = HarnessSession<any, any>
// biome-ignore lint/suspicious/noExplicitAny: a run of a loosely typed agent
type AnyRun = HarnessRun<any>

/** One subagent type. */
export interface SubagentDefinition {
  /**
   * The agent that runs the child sessions. It must share storage with the parent's agent so the
   * parent / child index works across instances, and for `approvals: 'park'` it needs
   * {@link subagentChild} (or `subagents({ parentAgent })`) installed.
   */
  agent: AnyAgent
  /** One line shown to the model in the tool description. */
  description: string
  /** `maxSteps` of the child's turns. */
  maxTurns?: number
}

/** Subagent types by name, or a function evaluated once per session. */
export type SubagentCatalog =
  | Record<string, SubagentDefinition>
  | (() => Record<string, SubagentDefinition>)

/** What the `answer` callback is asked (`approvals: 'inline'`). */
export type SubagentApprovalRequest =
  | {
      type: 'approval'
      /** Subagent type. */
      agent: string
      childSessionId: string
      approvalId: string
      toolCallId: string
      toolName: string
      input?: unknown
      risk?: string
    }
  | {
      type: 'client-tool'
      agent: string
      childSessionId: string
      toolCallId: string
      toolName: string
      input?: unknown
    }

/**
 * The answer: approve or deny an `'approval'` request, or give a `'client-tool'` request its
 * result. A mismatching shape denies / answers with an error.
 */
export type SubagentApprovalAnswer =
  | { approved: boolean; reason?: string; note?: string; remember?: 'once' | 'session' }
  | { output: unknown }
  | { errorText: string }

/** Options of {@link subagents}. */
export interface SubagentsOptions {
  /** The subagent types. */
  agents: SubagentCatalog
  /** Name of the tool. Default `'agent'`. */
  toolName?: string
  /**
   * Nesting limit: the root session is depth 0; a session at `maxDepth` does not get the tool.
   * Default 2.
   */
  maxDepth?: number
  /** Children running at once, per nesting depth and plugin instance. Default 8. */
  maxConcurrent?: number
  /**
   * Offer `run_in_background` (`'inline'` and `'policy'` only): the child runs detached and its
   * report is injected into the parent as an `eh.event` with `wake: true`. Default `false`.
   */
  background?: boolean
  /**
   * How the child's approvals and client tool calls are answered: `'inline'` (the `answer`
   * callback, in process), `'park'` (the parent parks as an external wait, ADR-0035) or
   * `'policy'` (automatically, see `policy`).
   */
  approvals: 'inline' | 'park' | 'policy'
  /** Required for `'inline'`. */
  answer?: (
    request: SubagentApprovalRequest,
    signal: AbortSignal,
  ) => Promise<SubagentApprovalAnswer> | SubagentApprovalAnswer
  /** For `'policy'`: `'deny'` (default) or `'approve'` every child approval. */
  policy?: 'deny' | 'approve'
  /** Child session id. Default `<parentId>:agent:<toolCallId>`. */
  childSessionId?: (parentSessionId: string, toolCallId: string) => string
  /**
   * `'park'`: the agent that owns this plugin's sessions. When set, `session.start` reconciles the
   * session's pending subagent waits in the background ({@link reconcileSubagentWaits}, children
   * opened on the catalog agents): a crash between a child finishing and its hook is healed when
   * the session opens. Best effort, never awaited by the open; failures are logged.
   */
  selfAgent?: () => AnyAgent
  /** `'park'`: timeout of the parent's wait in ms. Default none. */
  timeoutMs?: number
  /**
   * The agent that owns the parent sessions, for the `turn.end` hook this plugin installs when the
   * agent is itself a child of a `'park'` parent (see {@link subagentChild}). A function, so two
   * agents can reference each other.
   */
  parentAgent?: () => AnyAgent
  /**
   * `'park'`: called with the continuation run a child's completion started on the parent
   * (`resolveWait()`); drive or stream it. Default: the run is drained, its result is stored.
   */
  onParentRun?: (run: AnyRun, parentSessionId: string) => void
}

/** Progress of a running child (preliminary tool output; UI only). */
export interface SubagentProgress {
  status: 'running' | 'done' | 'failed'
  agent: string
  description: string
  sessionId: string
  steps: number
  lastTool?: string
  text: string
}

/** Data of `data-subagent.run` (persisted; id = the tool call id): lets a UI open the transcript. */
export interface SubagentRunData {
  toolCallId: string
  sessionId: string
  agent: string
  status: 'running' | 'waiting' | 'done' | 'failed'
}

const runSchema: FlexibleSchema<SubagentRunData> = z.object({
  toolCallId: z.string(),
  sessionId: z.string(),
  agent: z.string(),
  status: z.enum(['running', 'waiting', 'done', 'failed']),
}) as never

/** The data parts of the subagent plugin. */
export interface SubagentDataParts extends Record<string, DataPartDef> {
  run: DataPartDef<FlexibleSchema<SubagentRunData>>
}

const runPart: DataPartDef<FlexibleSchema<SubagentRunData>> = defineDataPart({
  schema: runSchema,
})

type Ctx = HarnessContext<SubagentDataParts>

interface AgentInput {
  subagent_type: string
  description: string
  prompt: string
  run_in_background?: boolean
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────

interface Semaphore {
  acquire(signal?: AbortSignal): Promise<boolean>
  release(): void
}

function createSemaphore(max: number): Semaphore {
  let running = 0
  const waiters: Array<() => void> = []
  return {
    async acquire(signal) {
      if (signal?.aborted === true) return false
      if (running < max) {
        running++
        return true
      }
      return await new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
          const i = waiters.indexOf(grant)
          if (i >= 0) waiters.splice(i, 1)
          resolve(false)
        }
        const grant = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(true)
        }
        waiters.push(grant)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    release() {
      const next = waiters.shift()
      if (next !== undefined) next()
      else running--
    },
  }
}

type PartLike = { type: string; text?: string; toolName?: string; input?: unknown }
type MessageLike = { id: string; role: string; parts: PartLike[] }

/** Text of a message, from the last `step-start` when `afterLastStep`. */
function textOf(message: MessageLike | undefined, afterLastStep: boolean): string {
  if (message === undefined) return ''
  let parts = message.parts
  if (afterLastStep) {
    const i = parts.map((p) => p.type).lastIndexOf('step-start')
    if (i >= 0) parts = parts.slice(i)
  }
  return parts
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('')
    .trim()
}

/** Final text of a turn result: the assistant message the turn wrote. */
function finalText(result: Pick<TurnResult, 'messages' | 'messageId'>): string {
  const messages = result.messages as unknown as MessageLike[]
  const assistant =
    messages.findLast((m) => m.id === result.messageId) ??
    messages.findLast((m) => m.role === 'assistant')
  return textOf(assistant, true)
}

function shortArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value !== '') {
      const line = value.replace(/\s+/g, ' ').trim()
      return line.length > 60 ? `${line.slice(0, 59)}…` : line
    }
  }
  return ''
}

/** Steps and latest tool of one streamed message. */
function inspect(message: MessageLike): { steps: number; lastTool?: string } {
  let steps = 0
  let lastTool: string | undefined
  for (const part of message.parts) {
    if (part.type === 'step-start') steps++
    else if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
      const name = part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice(5)
      const arg = shortArg(part.input)
      lastTool = arg === '' ? name : `${name} ${arg}`
    }
  }
  return { steps: Math.max(steps, lastTool === undefined ? 0 : 1), lastTool }
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function reportOf(text: string): string {
  return text.length > SUBAGENT_BACKGROUND_REPORT_CHARS
    ? `${text.slice(0, SUBAGENT_BACKGROUND_REPORT_CHARS)}\n… [report truncated]`
    : text
}

/** Text the parent model reads for a child that did not complete. */
const stoppedText = (stop: string, text: string): string => `[subagent stopped: ${stop}] ${text}`

/** Resolve the catalog once. */
function resolveCatalog(catalog: SubagentCatalog): Record<string, SubagentDefinition> {
  return typeof catalog === 'function' ? catalog() : catalog
}

// ─── driving a child turn (inline / policy) ───────────────────────────────────────────────

interface DriveArgs {
  session: AnySession
  agent: string
  options: SubagentsOptions
  signal: AbortSignal
  onRun?: (run: AnyRun) => void
}

/**
 * Awaits `first` and, while the child stops `tool-pending`, answers every open approval and client
 * tool call (through `answer` or the policy) and continues with `respond()`. Never throws for run
 * errors; an answer callback that throws denies.
 */
async function driveChild(first: AnyRun, args: DriveArgs): Promise<TurnResult> {
  const { session, options, signal } = args
  let run = first
  args.onRun?.(run)
  let result = (await run.result) as TurnResult
  while (result.stop === 'tool-pending' && result.pending !== undefined && !signal.aborted) {
    const pending: PendingState = result.pending
    const approvals: Array<{
      id: string
      approved: boolean
      reason?: string
      note?: string
      remember?: 'once' | 'session'
    }> = []
    for (const entry of pending.approvals) {
      if (entry.granted === true) continue
      if (options.approvals === 'policy') {
        approvals.push(
          options.policy === 'approve'
            ? { id: entry.approvalId, approved: true }
            : { id: entry.approvalId, approved: false, reason: SUBAGENT_NO_USER },
        )
        continue
      }
      let answer: SubagentApprovalAnswer
      try {
        answer = await (options.answer?.(
          {
            type: 'approval',
            agent: args.agent,
            childSessionId: session.id,
            approvalId: entry.approvalId,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            ...(entry.input === undefined ? {} : { input: entry.input }),
            ...(entry.risk === undefined ? {} : { risk: entry.risk }),
          },
          signal,
        ) ?? { approved: false })
      } catch {
        answer = { approved: false }
      }
      if (signal.aborted) {
        session.abort()
        return result
      }
      if ('approved' in answer && answer.approved) {
        const note = answer.note?.trim()
        approvals.push({
          id: entry.approvalId,
          approved: true,
          ...(note ? { note } : {}),
          ...(answer.remember === undefined ? {} : { remember: answer.remember }),
        })
      } else {
        approvals.push({
          id: entry.approvalId,
          approved: false,
          reason: ('reason' in answer ? answer.reason : undefined) || SUBAGENT_DENIED,
        })
      }
    }
    const toolOutputs: Array<
      { toolCallId: string; output: unknown } | { toolCallId: string; errorText: string }
    > = []
    for (const call of pending.clientTools) {
      if (call.result !== undefined) continue
      if (options.approvals === 'policy') {
        toolOutputs.push({ toolCallId: call.toolCallId, errorText: SUBAGENT_NO_CLIENT })
        continue
      }
      let answer: SubagentApprovalAnswer
      try {
        answer = await (options.answer?.(
          {
            type: 'client-tool',
            agent: args.agent,
            childSessionId: session.id,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            ...(call.input === undefined ? {} : { input: call.input }),
          },
          signal,
        ) ?? { errorText: SUBAGENT_NO_CLIENT })
      } catch (error) {
        answer = { errorText: errText(error) }
      }
      if (signal.aborted) {
        session.abort()
        return result
      }
      if ('output' in answer)
        toolOutputs.push({ toolCallId: call.toolCallId, output: answer.output })
      else if ('errorText' in answer)
        toolOutputs.push({ toolCallId: call.toolCallId, errorText: answer.errorText })
      else toolOutputs.push({ toolCallId: call.toolCallId, errorText: SUBAGENT_NO_CLIENT })
    }
    if ((pending.externals ?? []).some((w) => w.result === undefined)) {
      // an external wait inside the child cannot be answered in process: stop here
      return result
    }
    run = session.respond({ approvals, toolOutputs }, { abortSignal: signal }) as AnyRun
    args.onRun?.(run)
    result = (await run.result) as TurnResult
  }
  return result
}

// ─── park mode: pending summary and the child-side hook ───────────────────────────────────

/** JSON-safe summary of a child's pending state (the wait payload). */
function summarizePending(pending: PendingState): JSONValue {
  return {
    approvals: pending.approvals
      .filter((a) => a.granted !== true)
      .map((a) => ({
        approvalId: a.approvalId,
        toolCallId: a.toolCallId,
        toolName: a.toolName,
        ...(a.input === undefined ? {} : { input: a.input as JSONValue }),
      })),
    clientTools: pending.clientTools
      .filter((c) => c.result === undefined)
      .map((c) => ({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        ...(c.input === undefined ? {} : { input: c.input as JSONValue }),
      })),
  } as JSONValue
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
      else {
        void (async () => {
          try {
            for await (const _ of run.stream as AsyncIterable<unknown>) {
              // drained: the continuation is stored by the turn itself
            }
          } catch {
            // surfaces through run.result
          }
        })()
        void run.result.catch(() => {})
      }
    }
    return 'done'
  } catch (error) {
    if (isHarnessError(error) && error.code === 'EH_SESSION_BUSY') return 'busy'
    o.log.warn('subagent: resolving the parent wait failed', { error: errText(error) })
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
    const payload = wait.payload as { childSessionId?: unknown } | undefined
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
        error: errText(error),
      })
      out.push({ ...entry, status: 'skipped' })
    }
  }
  return out
}

/**
 * Child side of `'park'`: when a child's turn ends (not `tool-pending`), resolve the parent's wait
 * with its report. Returns the settle function; the first attempt is awaited, a busy parent (the
 * same instance still inside the turn that started the child) is retried in the background.
 */
function createParkHook(options: {
  parentAgent: (() => AnyAgent) | undefined
  onParentRun: ((run: AnyRun, parentSessionId: string) => void) | undefined
}): (ctx: HarnessContext, e: TurnResult) => Promise<void> {
  return async (ctx, e) => {
    const parent = ctx.session.parent
    if (parent?.toolCallId === undefined || e.stop === 'tool-pending') return
    if (options.parentAgent === undefined) return
    const parentSession = options.parentAgent().session(parent.sessionId) as AnySession
    const waitId = subagentWaitId(parent.toolCallId)
    let waits: Awaited<ReturnType<AnySession['pendingWaits']>>
    try {
      waits = await parentSession.pendingWaits()
    } catch (error) {
      ctx.log.warn('subagent: could not read the parent waits', { error: errText(error) })
      return
    }
    const wait = waits.find((w) => w.waitId === waitId)
    // not a parked child (inline, policy, background), or already resolved
    if (wait === undefined || wait.result !== undefined) return
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
}

/**
 * Plugin for agents that run as children of a `'park'` parent: its `turn.end` hook resolves the
 * parent's wait when the child's turn completes (in any instance). `parent` returns the agent that
 * owns the parent sessions; it is a function so two agents can reference each other.
 *
 * @example
 * ```ts
 * const worker = defineHarnessAgent({ ..., plugins: [subagentChild({ parent: () => main })] })
 * const main = defineHarnessAgent({ ..., plugins: [subagents({ agents: { worker: { agent: worker, description: '…' } }, approvals: 'park' })] })
 * ```
 */
export function subagentChild(options: {
  parent: () => AnyAgent
  onParentRun?: (run: AnyRun, parentSessionId: string) => void
}): HarnessPlugin<'subagent-child'> {
  const hook = createParkHook({ parentAgent: options.parent, onParentRun: options.onParentRun })
  return definePlugin({
    name: 'subagent-child',
    session: () => ({ hooks: { 'turn.end': hook } }) as SessionContribution,
  }) as HarnessPlugin<'subagent-child'>
}

/**
 * The child sessions of `session` (recursively) that wait for an approval or a client tool answer:
 * what a web UI lists so the user can answer them with `childSession.respond(...)`. Reads stored
 * state; works in any instance. `open` is the agent that runs the children (children of several
 * agents: a function that opens the child session on the right agent).
 */
export async function pendingSubagentApprovals(
  session: AnySession,
  open: AnyAgent | ((childSessionId: string) => AnySession),
): Promise<Array<{ sessionId: string; parentSessionId: string; pending: PendingState }>> {
  const out: Array<{ sessionId: string; parentSessionId: string; pending: PendingState }> = []
  const walk = async (parent: AnySession, depth: number): Promise<void> => {
    if (depth > 8) return
    for (const info of await parent.children()) {
      const child =
        typeof open === 'function'
          ? open(info.sessionId)
          : (open.session(info.sessionId) as AnySession)
      const stats = await child.stats()
      if (stats.pending !== null) {
        out.push({ sessionId: info.sessionId, parentSessionId: parent.id, pending: stats.pending })
      }
      await walk(child, depth + 1)
    }
  }
  await walk(session, 0)
  return out
}

// ─── the plugin ───────────────────────────────────────────────────────────────────────────

const BACKGROUND_FIELD =
  'Start the subagent in the background and return at once; its report arrives later as an event. Use it for work you do not need before continuing.'

function describeTypes(defs: Record<string, SubagentDefinition>): string {
  return Object.entries(defs)
    .map(([name, d]) => `- ${name}: ${d.description}`)
    .join('\n')
}

function toolDescription(defs: Record<string, SubagentDefinition>): string {
  return `Launch a subagent to handle a task on its own and return a report.

Available subagent types:
${describeTypes(defs)}

Usage:
- The subagent starts with no context: the prompt must be self-contained (goal, what you already know, the form of the answer you need).
- Only the subagent's final report comes back to you; it is not shown to the user.
- Launch independent subagents in parallel by calling this tool several times in one step.
- Do simple lookups yourself instead of launching a subagent.`
}

/**
 * The subagent plugin: contributes the `agent` tool and the `data-subagent.run` part.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
export function subagents(options: SubagentsOptions): HarnessPlugin<'subagent'> {
  if (options.approvals === 'inline' && options.answer === undefined) {
    throw new TypeError("subagents({ approvals: 'inline' }) needs an `answer` callback.")
  }
  if (options.approvals === 'park' && options.background === true) {
    throw new TypeError(
      "subagents({ background: true }) is not available with approvals: 'park' (a parked call always waits for its child).",
    )
  }
  const toolName = options.toolName ?? SUBAGENT_TOOL
  const maxDepth = options.maxDepth ?? 2
  const maxConcurrent = options.maxConcurrent ?? 8
  const semaphores = new Map<number, Semaphore>()
  /**
   * One semaphore per nesting depth: a child holds its slot while it waits for its own children,
   * so a single shared cap could be filled by waiting parents and starve their children.
   */
  const semaphoreFor = (depth: number): Semaphore => {
    let s = semaphores.get(depth)
    if (s === undefined) {
      s = createSemaphore(maxConcurrent)
      semaphores.set(depth, s)
    }
    return s
  }
  const childIdOf = (parentId: string, toolCallId: string): string =>
    options.childSessionId?.(parentId, toolCallId) ?? `${parentId}:agent:${toolCallId}`
  const parkHook = createParkHook({
    parentAgent: options.parentAgent,
    onParentRun: options.onParentRun,
  })

  return definePlugin({
    name: 'subagent',
    dataParts: { run: runPart },
    session: (ctx) => {
      const depth = ctx.session.parent?.depth ?? 0
      const hooks: Record<string, unknown> = { 'turn.end': parkHook }
      if (options.approvals === 'park' && options.selfAgent !== undefined) {
        const self = options.selfAgent
        hooks['session.start'] = () => {
          // detached: opening the session must not wait for (or fail on) the reconcile
          void (async () => {
            await sleep(0)
            if (ctx.signal.aborted) return
            const parentSession = self().session(ctx.session.id) as AnySession
            const catalog = resolveCatalog(options.agents)
            await reconcileSubagentWaits(parentSession, {
              openChild: (id, info) => {
                const def =
                  (info.agent === undefined ? undefined : catalog[info.agent]) ??
                  Object.values(catalog)[0]
                return (def as SubagentDefinition).agent.session(id) as AnySession
              },
              ...(options.onParentRun === undefined ? {} : { onParentRun: options.onParentRun }),
              log: ctx.log,
            })
          })().catch((error) =>
            ctx.log.warn('subagent: reconcile on open failed', { error: errText(error) }),
          )
        }
      }
      if (depth >= maxDepth) return { hooks } as SessionContribution
      const defs = resolveCatalog(options.agents)
      const names = Object.keys(defs)
      if (names.length === 0) return { hooks } as SessionContribution
      // resolved once per session so the description (and the prompt-cache prefix) stays stable
      const description = toolDescription(defs)
      const canBackground = options.background === true
      const inputSchema = z.object({
        subagent_type: z.enum(names as [string, ...string[]]).describe('The subagent type to use'),
        description: z.string().describe('A short (3-5 words) label for the task'),
        prompt: z.string().describe('The complete task for the subagent'),
        ...(canBackground
          ? { run_in_background: z.boolean().optional().describe(BACKGROUND_FIELD) }
          : {}),
      })
      const tools: Record<string, ToolInput> = {
        [toolName]:
          options.approvals === 'park'
            ? (parkTool(ctx, defs, depth, description, inputSchema) as ToolInput)
            : (runTool(ctx, defs, depth, description, inputSchema) as ToolInput),
      }
      return { tools, hooks } as SessionContribution
    },
  }) as unknown as HarnessPlugin<'subagent'>

  // ─── inline / policy: an ordinary tool that runs the child and streams progress ─────────

  function runTool(
    ctx: Ctx,
    defs: Record<string, SubagentDefinition>,
    depth: number,
    description: string,
    inputSchema: unknown,
  ): ToolInput {
    return tool({
      description,
      inputSchema: inputSchema as FlexibleSchema<AgentInput>,
      async *execute(
        { subagent_type, description: label, prompt, run_in_background },
        { toolCallId, abortSignal: toolSignal },
      ): AsyncGenerator<SubagentProgress | string, void, undefined> {
        const abortSignal = toolSignal ?? new AbortController().signal
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
        const sessionId = childIdOf(ctx.session.id, toolCallId)
        const parentInfo = {
          sessionId: ctx.session.id,
          turnId: turn.id,
          toolCallId,
          depth: depth + 1,
        }
        if (run_in_background === true && options.background === true) {
          yield startBackground(
            ctx,
            def,
            subagent_type,
            label,
            prompt,
            sessionId,
            parentInfo,
            depth,
          )
          return
        }
        const progress = (over: Partial<SubagentProgress>): SubagentProgress => ({
          status: 'running',
          agent: subagent_type,
          description: label,
          sessionId,
          steps: 0,
          text: '',
          ...over,
        })
        const marker = (status: SubagentRunData['status']): void => {
          if (ctx.stream.active) {
            ctx.stream.data(
              'run',
              { toolCallId, sessionId, agent: subagent_type, status },
              { id: toolCallId },
            )
          }
        }
        const sem = semaphoreFor(depth)
        marker('running')
        yield progress({ text: 'Waiting for a free subagent slot…' })
        if (!(await sem.acquire(abortSignal))) {
          marker('failed')
          yield progress({ status: 'failed' })
          yield `ERROR: subagent was aborted before it started.`
          return
        }
        let opened = false
        try {
          const child = def.agent.session(sessionId, { parent: parentInfo }) as AnySession
          opened = true
          // latest-value mailbox between the stream consumers (callbacks) and this generator
          let latest = progress({})
          let dirty = true
          let finished = false
          let wake: (() => void) | undefined
          const notify = (): void => {
            dirty = true
            wake?.()
          }
          let stepsBefore = 0
          let stepsNow = 0
          let lastMessage: MessageLike | undefined
          const consumers: Promise<void>[] = []
          const consume = async (run: AnyRun): Promise<void> => {
            stepsBefore += stepsNow
            stepsNow = 0
            try {
              for await (const message of readUIMessageStream({ stream: run.stream })) {
                const m = message as unknown as MessageLike
                lastMessage = m
                const info = inspect(m)
                stepsNow = info.steps
                latest = progress({
                  steps: stepsBefore + info.steps,
                  lastTool: info.lastTool ?? latest.lastTool,
                  text: textOf(m, true),
                })
                notify()
              }
            } catch {
              // stream errors surface through run.result
            }
          }
          const run = child.send(prompt, {
            abortSignal,
            ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
          }) as AnyRun
          const driven = driveChild(run, {
            session: child,
            agent: subagent_type,
            options,
            signal: abortSignal,
            onRun: (r) => {
              consumers.push(consume(r))
            },
          }).finally(async () => {
            await Promise.all(consumers)
            finished = true
            notify()
          })
          // observed below; this keeps an early exit of the generator from leaving it unhandled
          driven.catch(() => {})
          while (!finished || dirty) {
            if (!dirty) {
              await new Promise<void>((resolve) => {
                wake = resolve
                if (dirty || finished) resolve()
              })
              wake = undefined
              continue
            }
            dirty = false
            yield latest
            if (!finished) await sleep(100)
          }
          const result = await driven
          try {
            turn.addUsage(result.usage, {
              source: `subagent:${subagent_type}`,
            })
          } catch {
            // the parent turn is over; its cost is already final
          }
          const text = finalText(result) || textOf(lastMessage, true) || latest.text
          const complete = result.stop === 'complete'
          marker(complete ? 'done' : 'failed')
          yield progress({
            status: complete ? 'done' : 'failed',
            steps: latest.steps || result.steps,
            lastTool: latest.lastTool,
            text,
          })
          yield complete
            ? text || '(the subagent returned no text)'
            : result.stop === 'error'
              ? `ERROR: subagent failed${result.error === undefined ? '' : `: ${result.error.message}`}`
              : stoppedText(result.stop, text)
        } catch (error) {
          marker('failed')
          yield progress({ status: 'failed', text: errText(error) })
          yield `ERROR: subagent failed: ${errText(error)}`
        } finally {
          if (opened) await def.agent.closeSession(sessionId).catch(() => {})
          sem.release()
        }
      },
    })
  }

  /** Start a child detached from the calling turn; returns the text for the model. */
  function startBackground(
    ctx: Ctx,
    def: SubagentDefinition,
    agentName: string,
    label: string,
    prompt: string,
    sessionId: string,
    parentInfo: { sessionId: string; turnId: string; toolCallId: string; depth: number },
    depth: number,
  ): string {
    const ac = new AbortController()
    ctx.signal.addEventListener('abort', () => ac.abort('parent closed'), { once: true })
    const sem = semaphoreFor(depth)
    const finish = async (status: 'completed' | 'failed', text: string): Promise<void> => {
      const head = `Background subagent ${sessionId} (${agentName}: ${label}) ${status === 'completed' ? 'finished' : 'failed'}.`
      try {
        await ctx.session.inject(
          'eh.event',
          {
            name: 'subagent',
            text: `${head}\n\n${reportOf(text) || '(no report)'}`,
            data: { sessionId, agent: agentName, status },
          },
          { deliver: 'next-step', wake: true },
        )
      } catch (error) {
        // the parent session may be closed by now
        ctx.log.warn('subagent: could not deliver a background report', { error: errText(error) })
      }
    }
    void (async () => {
      if (!(await sem.acquire(ac.signal))) {
        await finish('failed', 'aborted before it started')
        return
      }
      let opened = false
      try {
        const child = def.agent.session(sessionId, { parent: parentInfo }) as AnySession
        opened = true
        const run = child.send(prompt, {
          abortSignal: ac.signal,
          ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
        }) as AnyRun
        const consumers: Promise<void>[] = []
        const result = await driveChild(run, {
          session: child,
          agent: agentName,
          options,
          signal: ac.signal,
          onRun: (r) => {
            consumers.push(
              (async () => {
                try {
                  for await (const _ of r.stream as AsyncIterable<unknown>) {
                    // drained
                  }
                } catch {
                  // surfaces through run.result
                }
              })(),
            )
          },
        })
        await Promise.all(consumers)
        try {
          ctx.turn?.addUsage(result.usage, {
            source: `subagent:${agentName}`,
          })
        } catch {
          // the parent turn is over
        }
        const text = finalText(result)
        await finish(
          result.stop === 'complete' ? 'completed' : 'failed',
          result.stop === 'complete' ? text : stoppedText(result.stop, text),
        )
      } catch (error) {
        await finish('failed', errText(error))
      } finally {
        if (opened) await def.agent.closeSession(sessionId).catch(() => {})
        sem.release()
      }
    })()
    return `Started background subagent ${sessionId} (${agentName}): ${label}. You will be notified when it finishes.`
  }

  // ─── park: an external tool whose start runs the child's first turn ─────────────────────

  function parkTool(
    ctx: Ctx,
    defs: Record<string, SubagentDefinition>,
    depth: number,
    description: string,
    inputSchema: unknown,
  ): ToolInput {
    /** Resolve at once with an error text (through the wait's own timeout path). */
    const failNow = (
      errorText: string,
    ): { timeoutAt: number; onTimeout: { errorText: string } } => ({
      timeoutAt: Date.now(),
      onTimeout: { errorText },
    })
    return externalTool({
      description,
      inputSchema: inputSchema as FlexibleSchema<AgentInput>,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      async start({ subagent_type, description: label, prompt }, event) {
        const def = defs[subagent_type]
        if (def === undefined) {
          return failNow(
            `ERROR: unknown subagent_type "${subagent_type}". Available: ${Object.keys(defs).join(', ')}`,
          )
        }
        const turn = ctx.turn
        if (turn === undefined)
          return failNow('ERROR: subagents can only be started inside a turn.')
        const sessionId = childIdOf(ctx.session.id, event.toolCallId)
        const base = { childSessionId: sessionId, agent: subagent_type, description: label }
        const child = def.agent.session(sessionId, {
          parent: {
            sessionId: ctx.session.id,
            turnId: turn.id,
            toolCallId: event.toolCallId,
            depth: depth + 1,
          },
        }) as AnySession
        const sem = semaphoreFor(depth)
        if (!(await sem.acquire(event.abortSignal))) {
          return failNow('ERROR: subagent was aborted before it started.')
        }
        try {
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
          const run = child.send(prompt, {
            abortSignal: event.abortSignal,
            ...(def.maxTurns === undefined ? {} : { maxSteps: def.maxTurns }),
          }) as AnyRun
          void (async () => {
            try {
              for await (const _ of run.stream as AsyncIterable<unknown>) {
                // drained: the child's messages are stored by its own turn
              }
            } catch {
              // surfaces through run.result
            }
          })()
          const result = (await run.result) as TurnResult
          try {
            turn.addUsage(result.usage, {
              source: `subagent:${subagent_type}`,
            })
          } catch {
            // the parent turn is over; its cost is already final
          }
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
            payload: { ...base, status: result.stop === 'complete' ? 'done' : 'failed' },
          }
        } catch (error) {
          return failNow(`ERROR: subagent failed: ${errText(error)}`)
        } finally {
          await def.agent.closeSession(sessionId).catch(() => {})
          sem.release()
        }
      },
    })
  }
}
