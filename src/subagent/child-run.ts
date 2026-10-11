/**
 * Helpers that run a child turn: the slot semaphore, the answer loop of `driveChild` (inline /
 * policy approvals) and small readers of streamed messages.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { type JSONValue, readUIMessageStream } from 'ai'
import type { PendingState, TurnResult } from '../index.ts'
import { errorText } from '../index.ts'
import { type MessageLike, textOf } from './report.ts'
import {
  type AnyRun,
  type AnySession,
  SUBAGENT_DENIED,
  SUBAGENT_NO_CLIENT,
  SUBAGENT_NO_USER,
  type SubagentApprovalAnswer,
  type SubagentCatalog,
  type SubagentDefinition,
  type SubagentOptions,
} from './types.ts'

export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<boolean>
  release(): void
}

export function createSemaphore(max: number): Semaphore {
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

/** Final text of a turn result: the assistant message the turn wrote. */
export function finalText(result: Pick<TurnResult, 'messages' | 'messageId'>): string {
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
export function inspect(message: MessageLike): { steps: number; lastTool?: string } {
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

/** Start of the result of a foreground subagent the user moved to the background. */
export const SUBAGENT_BACKGROUNDED_PREFIX = 'Subagent moved to the background as task'

/** Resolve the catalog once. */
export function resolveCatalog(catalog: SubagentCatalog): Record<string, SubagentDefinition> {
  return typeof catalog === 'function' ? catalog() : catalog
}
// ─── driving a child turn (inline / policy) ───────────────────────────────────────────────

interface DriveArgs {
  session: AnySession
  agent: string
  options: SubagentOptions
  signal: AbortSignal
  onRun?: (run: AnyRun) => void
}

/**
 * Awaits `first` and, while the child stops `tool-pending`, answers every open approval and client
 * tool call (through `answer` or the policy) and continues with `respond()`. Never throws for run
 * errors; an answer callback that throws denies.
 */
export async function driveChild(first: AnyRun, args: DriveArgs): Promise<TurnResult> {
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
        void session.abort().catch(() => {})
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
        answer = { errorText: errorText(error) }
      }
      if (signal.aborted) {
        void session.abort().catch(() => {})
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
export function summarizePending(pending: PendingState): JSONValue {
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Consume the UI stream of a run nobody renders, so its turn stores itself. Stream errors are
 * ignored: they surface through `run.result`, which never rejects (spec 05 §2).
 */
export function drain(run: AnyRun): void {
  void (async () => {
    try {
      for await (const _ of run.stream as AsyncIterable<unknown>) {
        // drained
      }
    } catch {
      // surfaces through run.result
    }
  })()
}

/** Charge a child's usage to a parent turn; a turn that is over has its cost final already. */
export function chargeUsage(
  turn: { addUsage(usage: TurnResult['usage'], options: { source: string }): void } | undefined,
  usage: TurnResult['usage'],
  source: string,
): void {
  try {
    turn?.addUsage(usage, { source })
  } catch {
    // the parent turn is over
  }
}

/** Close a child session, ignoring a failure (it may be gone already). */
export async function closeChild(def: SubagentDefinition, sessionId: string): Promise<void> {
  await def.agent.closeSession(sessionId).catch(() => {})
}

/** Feed every streamed UI message of `run` to `on`; stream errors surface through `run.result`. */
export async function readMessages(run: AnyRun, on: (message: MessageLike) => void): Promise<void> {
  try {
    for await (const message of readUIMessageStream({ stream: run.stream })) {
      on(message as unknown as MessageLike)
    }
  } catch {
    // surfaces through run.result
  }
}
