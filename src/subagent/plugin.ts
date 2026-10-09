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
import {
  type AddUsage,
  AGENT_MESSAGE_INSTRUCTIONS,
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_NAME_PATTERN,
  type AgentDirectory,
  type AgentEntry,
  type AgentSender,
  createDirectory,
  directoryFor,
  dropDirectory,
  findEntry,
  frameAgentMessage,
  nameProblem,
  registerKey,
  resolveLimits,
  rosterText,
  SEND_MESSAGE_TOOL,
  type SubagentMessageLimits,
  throttle,
} from './messaging.ts'
import {
  createSubagentTaskRegistry,
  type SubagentTaskRegistry,
  type SubagentTasks,
} from './tasks.ts'

declare module '../index.ts' {
  interface HarnessServices {
    /** Provided by `subagents()`: the background subagents this session started. */
    subagentTasks: SubagentTasks
  }
}

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
  /**
   * Whether a finished agent of this type can be resumed by `send_message` (a new turn on the same
   * child session, full history). Default `true`; set `false` for one-shot types such as read-only
   * search or plan agents (they can still receive messages while they run).
   */
  resumable?: boolean
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
   * Offer `run_in_background` in CHILD sessions too (default `false`). A child session is closed
   * when its turn ends, which aborts the background subagents it started, and its report would go
   * to a session nobody watches; so by default only the root session (and any session without a
   * `parent`) gets the field. Enable it only when your child sessions stay open (spec 20 §2.2).
   */
  backgroundInChildren?: boolean
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
   * The agent that owns this plugin's sessions. With `'park'` and when set, `session.start`
   * reconciles the session's pending subagent waits in the background ({@link reconcileSubagentWaits}, children
   * opened on the catalog agents): a crash between a child finishing and its hook is healed when
   * the session opens. Best effort, never awaited by the open; failures are logged.
   */
  selfAgent?: () => AnyAgent
  /**
   * Offer `send_message` and the `name` field of the `agent` tool (default `true`; never with
   * `approvals: 'park'`). A session that has the plugin and no catalog still gets `send_message`.
   * ADR-0038, spec 20 §5.
   */
  messaging?: boolean
  /** Name of the messaging tool. Default `'send_message'`. */
  messageToolName?: string
  /** Throttling of `send_message` (spec 20 §5.4). */
  messageLimits?: SubagentMessageLimits
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
  /** The `name` the model gave the agent (spec 20 §5). */
  name?: string
  /** Background task id (`agent-<n>`), when the agent has one (restores the id after a restart). */
  taskId?: string
}

const runSchema: FlexibleSchema<SubagentRunData> = z.object({
  toolCallId: z.string(),
  sessionId: z.string(),
  agent: z.string(),
  status: z.enum(['running', 'waiting', 'done', 'failed']),
  name: z.string().optional(),
  taskId: z.string().optional(),
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
  name?: string
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

/** Start of the result of a foreground subagent the user moved to the background. */
const SUBAGENT_BACKGROUNDED_PREFIX = 'Subagent moved to the background as task'

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

const NAME_FIELD =
  'A short name (lowercase letters, digits, hyphens) so you can address this agent later with send_message'

function messageDescription(name: string): string {
  return `Send a message to another agent of this session and keep working.

\`to\` is "main" (the agent that talks to the user, from a subagent), an agent id such as agent-2, a child session id, or the name you gave an agent.
- A running agent receives the message at its next step; nothing it is doing is interrupted.
- A finished agent is resumed on its own session, with its full history and your message as new input; its report arrives later like a background agent's report. One-shot agents that cannot be resumed refuse.
- Use ${name} to revise or extend an agent's work instead of stopping it and starting a new one.
- The receiver does not see your conversation: make the message self-contained, and do not repeat it.

${AGENT_MESSAGE_INSTRUCTIONS}`
}

function toolDescription(defs: Record<string, SubagentDefinition>, messageTool?: string): string {
  return `Launch a subagent to handle a task on its own and return a report.

Available subagent types:
${describeTypes(defs)}

Usage:
- The subagent starts with no context: the prompt must be self-contained (goal, what you already know, the form of the answer you need).
- Only the subagent's final report comes back to you; it is not shown to the user.
- Launch independent subagents in parallel by calling this tool several times in one step.
- Do simple lookups yourself instead of launching a subagent.${
    messageTool === undefined
      ? ''
      : `
- Give an agent a \`name\` if you may want to follow up on it later: ${messageTool} reaches it by name or id, also after it finished (unless it is a one-shot type).`
  }`
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

  const messageToolName = options.messageToolName ?? SEND_MESSAGE_TOOL
  const messaging = options.messaging !== false && options.approvals !== 'park'
  const limits = resolveLimits(options.messageLimits)

  /** Where a report goes: the `inject` of some session (ADR-0038). */
  type Reporter = (text: string, data: Record<string, unknown>) => Promise<void>

  /** Everything one session's plugin instance needs to start, address and resume children. */
  interface Scope {
    ctx: Ctx
    registry: SubagentTaskRegistry
    dir: AgentDirectory | undefined
    depth: number
    defs(): Record<string, SubagentDefinition>
    rebuilt: boolean
  }

  return definePlugin({
    name: 'subagent',
    provides: ['subagentTasks'],
    dataParts: { run: runPart },
    session: (ctx) => {
      const depth = ctx.session.parent?.depth ?? 0
      const isRoot = ctx.session.parent === undefined
      let dir: AgentDirectory | undefined
      if (messaging) {
        dir = isRoot
          ? createDirectory(ctx.session.id, async (text, data) => {
              await ctx.session.inject(
                'eh.event',
                { name: 'agent-message', text, data },
                { deliver: 'next-step', wake: true },
              )
            })
          : (directoryFor(ctx.session.id) ?? createDirectory(ctx.session.id, undefined))
      }
      let defsCache: Record<string, SubagentDefinition> | undefined
      const getDefs = (): Record<string, SubagentDefinition> => {
        defsCache ??= resolveCatalog(options.agents)
        return defsCache
      }
      let scope: Scope | undefined
      const registry = createSubagentTaskRegistry({
        foreign: async (childSessionId) => {
          // not a task of this process: ask the child session to abort, wherever it runs
          for (const def of Object.values(resolveCatalog(options.agents))) {
            const child = def.agent.session(childSessionId) as AnySession
            try {
              const out = await child.requestAbort('stopped')
              if (out.target !== 'idle') return
            } catch {
              // try the next agent
            } finally {
              await def.agent.closeSession(childSessionId).catch(() => {})
            }
          }
        },
        send: async (to, message) => {
          if (scope === undefined) return { ok: false, error: 'ERROR: the session is not ready.' }
          const text = message.trim()
          if (text === '') return { ok: false, error: 'ERROR: the message is empty.' }
          const routed = await route(scope, { kind: 'user' }, to, text)
          return routed.kind === 'error' || routed.kind === 'dropped'
            ? { ok: false, error: routed.text }
            : {
                ok: true,
                status: routed.kind === 'resumed' ? 'resumed' : 'delivered',
                id: routed.id,
              }
        },
      })
      const services = { subagentTasks: registry as SubagentTasks }
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
      const dispose = (): void => {
        void registry.stopAll()
        if (dir !== undefined && isRoot) dropDirectory(dir)
      }
      scope = { ctx, registry, dir, depth, defs: getDefs, rebuilt: false }
      const current: Scope = scope
      const tools: Record<string, ToolInput> = {}
      if (depth < maxDepth && Object.keys(getDefs()).length > 0) {
        const defs = getDefs()
        const names = Object.keys(defs)
        // resolved once per session so the description (and the prompt-cache prefix) stays stable
        const description = toolDescription(defs, messaging ? messageToolName : undefined)
        const canBackground =
          options.background === true &&
          (ctx.session.parent === undefined || options.backgroundInChildren === true)
        const inputSchema = z.object({
          subagent_type: z
            .enum(names as [string, ...string[]])
            .describe('The subagent type to use'),
          description: z.string().describe('A short (3-5 words) label for the task'),
          prompt: z.string().describe('The complete task for the subagent'),
          ...(canBackground
            ? { run_in_background: z.boolean().optional().describe(BACKGROUND_FIELD) }
            : {}),
          ...(messaging
            ? { name: z.string().regex(AGENT_NAME_PATTERN).optional().describe(NAME_FIELD) }
            : {}),
        })
        tools[toolName] =
          options.approvals === 'park'
            ? (parkTool(ctx, defs, depth, description, inputSchema) as ToolInput)
            : (runTool(ctx, defs, depth, description, inputSchema, registry, current) as ToolInput)
      }
      if (messaging) tools[messageToolName] = messageTool(current, messageToolName)
      if (dir !== undefined) {
        const roster = dir
        hooks['step.prepare'] = async () => {
          const self = roster.entries.get(ctx.session.id)
          if (self !== undefined) self.queued.length = 0
          if (ctx.session.id === roster.rootId) roster.mainQueued.length = 0
          await rebuildEntries(current)
          const text = rosterText(
            roster,
            ctx.session.id,
            ctx.session.id === roster.rootId,
            messageToolName,
          )
          return text === undefined ? undefined : { reminder: text }
        }
      }
      return { tools, hooks, services, dispose } as SessionContribution
    },
  }) as unknown as HarnessPlugin<'subagent'>

  // ─── the directory: entries, wiring and resume (ADR-0038) ───────────────────────────────

  /** Register an addressable child of this session. */
  function addEntry(
    scope: Scope,
    init: {
      childSessionId: string
      agent: string
      description: string
      name?: string
      taskId?: string
      status?: AgentEntry['status']
      parentInfo: AgentEntry['parentInfo']
    },
  ): AgentEntry | undefined {
    const dir = scope.dir
    if (dir === undefined) return undefined
    const entry: AgentEntry = {
      childSessionId: init.childSessionId,
      ownerSessionId: scope.ctx.session.id,
      parentInfo: init.parentInfo,
      agent: init.agent,
      description: init.description,
      status: init.status ?? 'running',
      resumable: scope.defs()[init.agent]?.resumable !== false,
      startedAt: Date.now(),
      queued: [],
      ...(init.name === undefined ? {} : { name: init.name }),
      ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    }
    entry.resume = (text, sender) => resumeEntry(scope, entry, text, sender)
    dir.entries.set(init.childSessionId, entry)
    registerKey(dir, init.childSessionId)
    return entry
  }

  /** The child runs: messages can be delivered into it. */
  function wireRunning(entry: AgentEntry, child: AnySession): void {
    entry.status = 'running'
    entry.deliver = async (text, data) => {
      await child.inject(
        'eh.event',
        { name: 'agent-message', text, data },
        { deliver: 'next-step' },
      )
    }
    entry.deliverUser = async (text) => {
      // a steer: the text lands at the next step boundary as `data-eh.input { source: 'user' }`
      const run = child.send(text, { ifBusy: 'steer' }) as AnyRun
      void (async () => {
        try {
          for await (const _ of run.stream as AsyncIterable<unknown>) {
            // drained: the turn stores itself
          }
        } catch {
          // surfaces through run.result
        }
      })()
      void run.result.catch(() => {})
    }
  }

  function finishEntry(entry: AgentEntry | undefined, status: AgentEntry['status']): void {
    if (entry === undefined) return
    if (entry.status !== 'stopped') entry.status = status
    entry.deliver = undefined
    entry.deliverUser = undefined
    entry.queued.length = 0
  }

  /** Start a new turn on a finished child (ADR-0038); resolves to the text for the sender. */
  async function resumeEntry(
    scope: Scope,
    entry: AgentEntry,
    text: string,
    sender: AgentSender,
  ): Promise<string> {
    const def = scope.defs()[entry.agent]
    if (def === undefined) {
      return `ERROR: the agent type "${entry.agent}" is not available any more; it cannot be resumed.`
    }
    const taskId = launch({
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
    return taskId
  }

  function reporterOf(ctx: Ctx): Reporter {
    return async (text, data) => {
      await ctx.session.inject(
        'eh.event',
        { name: 'subagent', text, data },
        { deliver: 'next-step', wake: true },
      )
    }
  }

  type Routed =
    | { kind: 'error'; text: string }
    | { kind: 'dropped'; text: string }
    | { kind: 'delivered'; label: string; id: string }
    | { kind: 'resumed'; label: string; id: string }

  function fail(text: string): Routed {
    return { kind: 'error', text: text.startsWith('ERROR') ? text : `ERROR: ${text}` }
  }

  /** Find the target of a message, check the rules, then deliver or resume. */
  async function route(
    scope: Scope,
    sender: AgentSender,
    to: string,
    text: string,
  ): Promise<Routed> {
    const dir = scope.dir
    if (dir === undefined) return fail('messaging is not available in this session.')
    if (text.length > AGENT_MESSAGE_MAX_CHARS) {
      return fail(
        `the message is too long (${text.length} characters, at most ${AGENT_MESSAGE_MAX_CHARS}). Shorten it.`,
      )
    }
    const key = to.trim()
    if (key === '') return fail('`to` is empty.')
    const isMain = key.toLowerCase() === 'main'
    let target = isMain ? undefined : findEntry(dir, key)
    if (!isMain && target === undefined) {
      await rebuildEntries(scope)
      target = findEntry(dir, key)
    }
    const known = (): string =>
      [
        ...(sender.kind === 'agent' && sender.sessionId === dir.rootId ? [] : ['main']),
        ...[...dir.entries.values()].map((e) => e.name ?? e.taskId ?? e.childSessionId),
      ].join(', ')
    const senderLabel = sender.kind === 'agent' ? sender.label : 'user'
    const senderId = sender.kind === 'agent' ? sender.id : 'user'

    if (isMain) {
      if (sender.kind === 'user') return fail('the user talks to main in the main conversation.')
      if (sender.sessionId === dir.rootId)
        return fail('you are the main agent; you cannot message yourself.')
      if (dir.main === undefined) return fail('the main agent cannot be reached from this session.')
      const limited = throttle(dir, `${senderId}->main`, text, limits, dir.mainQueued)
      if (limited !== undefined) {
        return limited.startsWith('ERROR') ? fail(limited) : { kind: 'dropped', text: limited }
      }
      const relation =
        dir.entries.get(sender.sessionId)?.ownerSessionId === dir.rootId ? 'child' : 'peer'
      const framed = frameAgentMessage(text, { label: senderLabel, id: senderId }, relation)
      try {
        await dir.main(framed, { from: senderLabel, fromId: senderId })
      } catch (error) {
        return fail(`could not deliver the message to main: ${errText(error)}`)
      }
      return { kind: 'delivered', label: 'main', id: 'main' }
    }

    if (target === undefined) return fail(`no agent "${key}". You can message: ${known()}.`)
    const entry = target
    const label = entry.name ?? entry.taskId ?? entry.childSessionId
    if (sender.kind === 'agent' && entry.childSessionId === sender.sessionId) {
      return fail('you cannot message yourself.')
    }
    if (entry.status === 'stopped') {
      return fail(`${label} was cancelled by the user and cannot be messaged.`)
    }
    const running = entry.status === 'running'
    if (!running && !entry.resumable) {
      return fail(
        `${label} (${entry.agent}) has finished and cannot be resumed (a one-shot agent). Start a new agent with the ${toolName} tool if more work is needed.`,
      )
    }
    if (running && entry.deliver === undefined) {
      return fail(`${label} is still starting; send the message again in a moment.`)
    }
    if (sender.kind === 'agent') {
      const limited = throttle(
        dir,
        `${senderId}->${entry.childSessionId}`,
        text,
        limits,
        entry.queued,
      )
      if (limited !== undefined) {
        return limited.startsWith('ERROR') ? fail(limited) : { kind: 'dropped', text: limited }
      }
    }
    const relation =
      sender.kind === 'agent' && sender.sessionId === entry.ownerSessionId
        ? 'launcher'
        : sender.kind === 'agent' &&
            dir.entries.get(sender.sessionId)?.ownerSessionId === entry.childSessionId
          ? 'child'
          : 'peer'
    const payload =
      sender.kind === 'agent'
        ? frameAgentMessage(text, { label: senderLabel, id: senderId }, relation)
        : text
    const id = entry.taskId ?? entry.childSessionId
    if (running) {
      try {
        if (sender.kind === 'user') await entry.deliverUser?.(text)
        else await entry.deliver?.(payload, { from: senderLabel, fromId: senderId })
        return { kind: 'delivered', label, id }
      } catch (error) {
        if (isHarnessError(error) && error.code === 'EH_SESSION_CLOSED') {
          return fail(`${label} is just finishing; send the message again in a moment.`)
        }
        return fail(`could not deliver the message to ${label}: ${errText(error)}`)
      }
    }
    if (entry.resume === undefined) return fail(`${label} cannot be resumed.`)
    const out = await entry.resume(payload, sender)
    if (out.startsWith('ERROR')) return fail(out)
    return { kind: 'resumed', label, id: out }
  }

  /** The `send_message` tool of one session. */
  function messageTool(scope: Scope, name: string): ToolInput {
    const schema = z.object({
      to: z
        .string()
        .describe('"main", an agent id such as agent-2, a child session id, or the name you gave'),
      message: z.string().describe('The message; it must be self-contained'),
    })
    return tool({
      description: messageDescription(name),
      inputSchema: schema as unknown as FlexibleSchema<{ to: string; message: string }>,
      async execute({ to, message }): Promise<string> {
        const { ctx, dir } = scope
        if (dir === undefined) return 'ERROR: messaging is not available in this session.'
        const text = message.trim()
        if (text === '') return 'ERROR: the message is empty.'
        const self = dir.entries.get(ctx.session.id)
        const isRoot = ctx.session.id === dir.rootId
        const sender: AgentSender = {
          kind: 'agent',
          label: isRoot ? 'main' : (self?.name ?? self?.taskId ?? self?.agent ?? 'agent'),
          id: isRoot ? 'main' : (self?.taskId ?? ctx.session.id),
          sessionId: ctx.session.id,
          report: reporterOf(ctx),
          addUsage: (usage, source) => {
            try {
              ctx.turn?.addUsage(usage, { source })
            } catch {
              // the sender's turn is over
            }
          },
        }
        const routed = await route(scope, sender, to, text)
        switch (routed.kind) {
          case 'error':
          case 'dropped':
            return routed.text
          case 'delivered':
            return routed.label === 'main'
              ? 'Message sent to main. It sees it at its next step, or now if it is idle.'
              : `Message delivered to ${routed.label}. It sees it at its next step; its answer, if any, comes back as a message.`
          case 'resumed':
            return `${routed.label} had finished; it was resumed on the same session with your message and runs in the background as ${routed.id}. Its report arrives here when it finishes.`
        }
      },
    }) as ToolInput
  }

  /**
   * After a restart this process knows none of the earlier children: rebuild finished entries
   * from the markers and reports stored in this session (once, needs `selfAgent`).
   */
  async function rebuildEntries(scope: Scope): Promise<void> {
    const dir = scope.dir
    if (scope.rebuilt || dir === undefined || options.selfAgent === undefined) return
    scope.rebuilt = true
    const { ctx } = scope
    try {
      const session = options.selfAgent().session(ctx.session.id) as AnySession
      const children = await session.children()
      if (children.length === 0) return
      const byChild = new Map(children.map((c) => [c.sessionId, c]))
      type Stored = { id: string; parts: Array<{ type: string; data?: unknown }> }
      const markers = new Map<string, SubagentRunData>()
      const outcomes = new Map<string, string>()
      let before: string | undefined
      for (let page = 0; page < 5 && markers.size < 100; page++) {
        const batch = (await session.messages({
          limit: 200,
          ...(before === undefined ? {} : { beforeId: before }),
        })) as unknown as Stored[]
        if (batch.length === 0) break
        for (const message of batch.toReversed()) {
          for (const part of message.parts.toReversed()) {
            if (part.type === 'data-subagent.run') {
              const d = part.data as SubagentRunData
              if (!markers.has(d.sessionId)) markers.set(d.sessionId, d)
            } else if (part.type === 'data-eh.event') {
              const d = part.data as {
                name?: string
                data?: { sessionId?: string; status?: string }
              }
              if (d.name === 'subagent' && d.data?.sessionId !== undefined && d.data.status) {
                if (!outcomes.has(d.data.sessionId)) outcomes.set(d.data.sessionId, d.data.status)
              }
            }
          }
        }
        before = batch[0]?.id
        if (batch.length < 200) break
      }
      const defs = scope.defs()
      for (const [sessionId, marker] of markers) {
        if (dir.entries.has(sessionId)) continue
        const def = defs[marker.agent]
        const info = byChild.get(sessionId)
        if (def === undefined || info === undefined) continue
        let status: AgentEntry['status']
        const reported = outcomes.get(sessionId)
        if (reported === 'stopped' || reported === 'completed' || reported === 'failed') {
          status = reported
        } else if (marker.status === 'done') status = 'completed'
        else if (marker.status === 'failed') status = 'failed'
        else {
          // the marker says running: the stored child tells how its last turn ended
          const child = def.agent.session(sessionId) as AnySession
          try {
            const stored = (await child.messages({ limit: 20 })) as unknown as Array<{
              role: string
              metadata?: { eharness?: { stop?: string } }
            }>
            const last = stored.findLast((m) => m.role === 'assistant')
            status = last?.metadata?.eharness?.stop === 'complete' ? 'completed' : 'failed'
          } finally {
            await def.agent.closeSession(sessionId).catch(() => {})
          }
        }
        addEntry(scope, {
          childSessionId: sessionId,
          agent: marker.agent,
          description: marker.name ?? marker.agent,
          status,
          ...(marker.name === undefined ? {} : { name: marker.name }),
          ...(marker.taskId === undefined ? {} : { taskId: marker.taskId }),
          parentInfo: {
            sessionId: ctx.session.id,
            turnId: info.turnId,
            toolCallId: info.toolCallId ?? marker.toolCallId,
            depth: scope.depth + 1,
          },
        })
        const n = Number(/^agent-(\d+)$/.exec(marker.taskId ?? '')?.[1] ?? 0)
        if (n > 0) scope.registry.reserve(n)
      }
    } catch (error) {
      ctx.log.warn('subagent: could not rebuild the agent directory', { error: errText(error) })
    }
  }

  // ─── inline / policy: an ordinary tool that runs the child and streams progress ─────────

  function runTool(
    ctx: Ctx,
    defs: Record<string, SubagentDefinition>,
    depth: number,
    description: string,
    inputSchema: unknown,
    registry: SubagentTaskRegistry,
    scope: Scope,
  ): ToolInput {
    return tool({
      description,
      inputSchema: inputSchema as FlexibleSchema<AgentInput>,
      async *execute(
        { subagent_type, description: label, prompt, run_in_background, name },
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
        const dir = scope.dir
        if (dir !== undefined && name !== undefined) {
          await rebuildEntries(scope)
          const problem = nameProblem(dir, name)
          if (problem !== undefined) {
            yield problem
            return
          }
        }
        const sessionId = childIdOf(ctx.session.id, toolCallId)
        const parentInfo = {
          sessionId: ctx.session.id,
          turnId: turn.id,
          toolCallId,
          depth: depth + 1,
        }
        if (
          run_in_background === true &&
          options.background === true &&
          (ctx.session.parent === undefined || options.backgroundInChildren === true)
        ) {
          yield startBackground(
            scope,
            toolCallId,
            def,
            subagent_type,
            label,
            prompt,
            sessionId,
            parentInfo,
            name,
          )
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
        const canDetach =
          options.background === true &&
          (ctx.session.parent === undefined || options.backgroundInChildren === true)
        const sem = semaphoreFor(depth)
        marker('running')
        yield progress({ text: 'Waiting for a free subagent slot…' })
        if (!(await sem.acquire(abortSignal))) {
          finishEntry(entry, 'failed')
          marker('failed')
          yield progress({ status: 'failed' })
          yield `ERROR: subagent was aborted before it started.`
          return
        }
        let opened = false
        // the child's own abort: follows the tool call until the user moves it to the background
        const childAc = new AbortController()
        const onToolAbort = (): void => childAc.abort(abortSignal.reason)
        const onParentClosed = (): void => childAc.abort('parent closed')
        if (abortSignal.aborted) onToolAbort()
        else abortSignal.addEventListener('abort', onToolAbort, { once: true })
        ctx.signal.addEventListener('abort', onParentClosed, { once: true })
        let detachedId: string | undefined
        let handedOff = false
        try {
          const child = def.agent.session(sessionId, { parent: parentInfo }) as AnySession
          opened = true
          if (entry !== undefined) wireRunning(entry, child)
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
                if (detachedId !== undefined) {
                  registry.setTail(detachedId, textOf(m, true) || info.lastTool || '')
                }
              }
            } catch {
              // stream errors surface through run.result
            }
          }
          const run = child.send(prompt, {
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
          // observed below; this keeps an early exit of the generator from leaving it unhandled
          driven.catch(() => {})
          if (canDetach) {
            registry.foreground.set(toolCallId, () => {
              if (detachedId !== undefined || finished) return undefined
              abortSignal.removeEventListener('abort', onToolAbort)
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
          while ((!finished || dirty) && detachedId === undefined) {
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
          if (detachedId !== undefined) {
            const taskId = detachedId
            handedOff = true
            const finish = backgroundFinisher(
              ctx,
              registry,
              taskId,
              def,
              subagent_type,
              label,
              sessionId,
              (status) => {
                if (ctx.stream.active && ctx.turn?.id === parentInfo.turnId) {
                  ctx.stream.data('run', runData(status), { id: toolCallId })
                }
              },
              { entry, ...(name === undefined ? {} : { name }) },
            )
            void (async () => {
              try {
                const result = await driven
                await Promise.all(consumers)
                try {
                  ctx.turn?.addUsage(result.usage, { source: `subagent:${subagent_type}` })
                } catch {
                  // the parent turn is over
                }
                const text = finalText(result) || textOf(lastMessage, true)
                await finish(
                  result.stop === 'complete' ? 'completed' : 'failed',
                  result.stop === 'complete' ? text : stoppedText(result.stop, text),
                )
              } catch (error) {
                await finish('failed', errText(error))
              } finally {
                ctx.signal.removeEventListener('abort', onParentClosed)
                await def.agent.closeSession(sessionId).catch(() => {})
                sem.release()
              }
            })()
            const soFar = latest.text || latest.lastTool || ''
            yield progress({ status: 'running', text: 'Moved to the background.' })
            yield `${SUBAGENT_BACKGROUNDED_PREFIX} ${taskId} (${subagent_type}): ${label}, by the user.${
              soFar === '' ? '' : ` Progress so far: ${reportOf(soFar.slice(-1000))}`
            } You will be notified when it finishes.`
            return
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
          finishEntry(entry, complete ? 'completed' : 'failed')
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
          finishEntry(entry, 'failed')
          marker('failed')
          yield progress({ status: 'failed', text: errText(error) })
          yield `ERROR: subagent failed: ${errText(error)}`
        } finally {
          registry.foreground.delete(toolCallId)
          abortSignal.removeEventListener('abort', onToolAbort)
          if (!handedOff) {
            ctx.signal.removeEventListener('abort', onParentClosed)
            if (opened) await def.agent.closeSession(sessionId).catch(() => {})
            sem.release()
          }
        }
      },
    })
  }

  /** The completion of a background child: registry, run marker and the report to the reader. */
  function backgroundFinisher(
    ctx: Ctx,
    registry: SubagentTaskRegistry,
    taskId: string,
    _def: SubagentDefinition,
    agentName: string,
    label: string,
    sessionId: string,
    marker: (status: SubagentRunData['status']) => void,
    extra: {
      entry?: AgentEntry | undefined
      name?: string
      /** Where the report goes. Default: the session that started the child. */
      report?: Reporter
      resumed?: boolean
    } = {},
  ): (status: 'completed' | 'failed', text: string) => Promise<void> {
    const report = extra.report ?? reporterOf(ctx)
    return async (status, text) => {
      const stopped = registry.stopped(taskId)
      registry.complete(taskId, status)
      finishEntry(extra.entry, stopped ? 'stopped' : status)
      marker(status === 'completed' ? 'done' : 'failed')
      const outcome = stopped ? 'stopped' : status
      const head = `${extra.resumed === true ? 'Resumed subagent' : 'Background subagent'} ${sessionId} (${agentName}: ${label}) ${
        stopped ? 'was stopped' : status === 'completed' ? 'finished' : 'failed'
      }.`
      try {
        await report(`${head}\n\n${reportOf(text) || '(no report)'}`, {
          sessionId,
          agent: agentName,
          status: outcome,
          taskId,
          ...(extra.name === undefined ? {} : { name: extra.name }),
        })
      } catch (error) {
        // the receiving session may be closed by now
        ctx.log.warn('subagent: could not deliver a background report', { error: errText(error) })
      }
    }
  }

  /** Start a child detached from the calling turn; returns the text for the model. */
  function startBackground(
    scope: Scope,
    toolCallId: string,
    def: SubagentDefinition,
    agentName: string,
    label: string,
    prompt: string,
    sessionId: string,
    parentInfo: { sessionId: string; turnId: string; toolCallId: string; depth: number },
    name: string | undefined,
  ): string {
    const entry = addEntry(scope, {
      childSessionId: sessionId,
      agent: agentName,
      description: label,
      parentInfo,
      ...(name === undefined ? {} : { name }),
    })
    const taskId = launch({
      scope,
      def,
      entry,
      agentName,
      label,
      prompt,
      sessionId,
      parentInfo,
      toolCallId,
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
    sessionId: string
    parentInfo: { sessionId: string; turnId: string; toolCallId?: string; depth: number }
    /** Run marker (first start only). */
    toolCallId?: string
    /** Existing task id: the task runs again. */
    taskId?: string
    report?: Reporter
    addUsage?: AddUsage
    resumed: boolean
  }): string {
    const { scope, def, entry, agentName, label, sessionId, parentInfo } = a
    const { ctx, registry, depth } = scope
    const ac = new AbortController()
    ctx.signal.addEventListener('abort', () => ac.abort('parent closed'), { once: true })
    const sem = semaphoreFor(depth)
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
    const finish = backgroundFinisher(
      ctx,
      registry,
      taskId,
      def,
      agentName,
      label,
      sessionId,
      marker,
      {
        entry,
        resumed: a.resumed,
        ...(a.name === undefined ? {} : { name: a.name }),
        ...(a.report === undefined ? {} : { report: a.report }),
      },
    )
    void (async () => {
      if (!(await sem.acquire(ac.signal))) {
        await finish('failed', 'aborted before it started')
        return
      }
      let opened = false
      try {
        const child = def.agent.session(sessionId, { parent: parentInfo }) as AnySession
        opened = true
        if (entry !== undefined) wireRunning(entry, child)
        const run = child.send(a.prompt, {
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
                  for await (const message of readUIMessageStream({ stream: r.stream })) {
                    const m = message as unknown as MessageLike
                    registry.setTail(taskId, textOf(m, true) || inspect(m).lastTool || '')
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
          if (a.addUsage !== undefined) a.addUsage(result.usage, `subagent:${agentName}`)
          else ctx.turn?.addUsage(result.usage, { source: `subagent:${agentName}` })
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
    return taskId
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
