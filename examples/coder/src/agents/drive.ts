/**
 * Drives a turn to its end: answers every `tool-pending` stop through the approval broker and
 * continues with `respond()`. Shared by the controller (main agent) and the `agent` tool (children).
 */
import type { HarnessRun, HarnessSession, TurnResult } from 'eharness'
import { QUESTION_TIMEOUT_NOTE, withQuestionTimeout } from '../app/ask-timeout.ts'
import {
  type ApprovalBroker,
  type ApprovalRequest,
  type CoderMessage,
  type PermissionEngine,
  type PermissionMode,
  TOOL,
  type ToolCallInfo,
} from '../contracts.ts'
import { formatAnswers, parseQuestions, questionRequest } from './ask-tool.ts'

/** Options of {@link driveTurn}. */
export interface DriveOptions {
  session: HarnessSession<CoderMessage>
  broker: ApprovalBroker
  permissions: PermissionEngine
  /** Title/detail/suggested rule of a pending call (permissions/describe.ts). */
  describe(call: ToolCallInfo): Promise<{ title: string; detail?: string; suggestedRule?: string }>
  /** Subagent name, shown in prompts; undefined for the main agent. */
  agent?: string
  signal?: AbortSignal
  /** Called with every run (the first one and every respond continuation) before it is awaited; must consume run.stream if it wants the chunks. */
  onRun?(run: HarnessRun<CoderMessage>): void
  /**
   * A bare "No" (no feedback) on a prompt stops the turn: `respond(…, { endTurn: 'if-denied' })`
   * records the denial and ends the turn without a model call. Main agent only; a subagent's
   * denial lets the child continue.
   */
  stopOnBareDeny?: boolean
  /**
   * Seconds after which an unanswered `ask_user_question` dialog is dismissed (the
   * `askUserQuestionTimeout` setting, read per question; 0 or absent = never). The tool result
   * then carries {@link QUESTION_TIMEOUT_NOTE}.
   */
  questionTimeout?(): number | undefined
}

/** Input of a tool call from the stored messages (only for an input too large for the pending state). */
async function storedInput(
  session: HarnessSession<CoderMessage>,
  toolCallId: string,
): Promise<unknown> {
  const messages = await session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.parts ?? []) {
      const p = part as { toolCallId?: string; input?: unknown }
      if (p.toolCallId === toolCallId) return p.input
    }
  }
  return undefined
}

const DENIED = 'Denied by the user.'

/** The part of the permission engine that remembers the mode chosen on a plan approval. */
interface PlanExitControl {
  setPlanExitMode(mode: PermissionMode | undefined): void
}

/**
 * Awaits `first`, and while the turn stops `tool-pending` asks the user for each open approval
 * (one prompt at a time), applies "don't ask again" rules and continues with `respond()`.
 * Resolves with the last result; never throws for run errors.
 */
export async function driveTurn(
  first: HarnessRun<CoderMessage>,
  opts: DriveOptions,
): Promise<TurnResult<CoderMessage>> {
  const { session, broker, permissions, signal } = opts
  let run = first
  opts.onRun?.(run)
  let result = await run.result
  while (result.stop === 'tool-pending' && result.pending !== undefined && !signal?.aborted) {
    const pending = result.pending
    const approvals: Array<{ id: string; approved: boolean; reason?: string; note?: string }> = []
    let bareDeny = false
    for (const entry of pending.approvals) {
      if (entry.granted) continue
      const call: ToolCallInfo = { toolName: entry.toolName, input: entry.input, agent: opts.agent }
      const description = await opts.describe(call)
      const request: ApprovalRequest = {
        id: entry.approvalId,
        agent: opts.agent,
        toolName: entry.toolName,
        input: entry.input,
        title: description.title,
        detail: description.detail,
        suggestedRule: description.suggestedRule,
      }
      let answer: Awaited<ReturnType<ApprovalBroker['ask']>>
      try {
        answer = await broker.ask(request, signal)
      } catch {
        answer = { approved: false }
      }
      if (signal?.aborted) {
        session.abort()
        return result
      }
      if (answer.approved) {
        if (answer.remember !== undefined && request.suggestedRule !== undefined) {
          await permissions.allow(request.suggestedRule, answer.remember)
        }
        const note = answer.note?.trim()
        if (entry.toolName === TOOL.exitPlan && opts.agent === undefined) {
          // the user chose the mode to continue in; the exit_plan_mode tool switches to it
          const chosen =
            answer.mode === 'acceptEdits' || answer.mode === 'default' ? answer.mode : undefined
          const engine = permissions as Partial<PlanExitControl>
          engine.setPlanExitMode?.(chosen)
        }
        approvals.push({ id: entry.approvalId, approved: true, ...(note ? { note } : {}) })
      } else {
        if (!answer.feedback) bareDeny = true
        approvals.push({ id: entry.approvalId, approved: false, reason: answer.feedback || DENIED })
      }
    }
    const toolOutputs: Array<
      { toolCallId: string; output: string } | { toolCallId: string; errorText: string }
    > = []
    for (const call of pending.clientTools) {
      if (call.toolName !== TOOL.ask) {
        toolOutputs.push({
          toolCallId: call.toolCallId,
          errorText: 'Not supported in this client.',
        })
        continue
      }
      // the pending state carries the input; the stored part only when it was too large to copy
      let input: unknown = call.input
      if (call.inputTruncated) input = await storedInput(session, call.toolCallId)
      const parsed = parseQuestions(input)
      if ('error' in parsed) {
        toolOutputs.push({ toolCallId: call.toolCallId, errorText: parsed.error })
        continue
      }
      const request = questionRequest(call.toolCallId, parsed.questions, opts.agent)
      const asked = await withQuestionTimeout(
        (s) => broker.question(request, s),
        opts.questionTimeout?.() ?? 0,
        signal,
      )
      if (signal?.aborted) {
        session.abort()
        return result
      }
      const text = formatAnswers(request, asked.result)
      toolOutputs.push({
        toolCallId: call.toolCallId,
        output: asked.timedOut ? `${text}\n\n${asked.note ?? QUESTION_TIMEOUT_NOTE}` : text,
      })
    }
    run = session.respond(
      { approvals, toolOutputs },
      {
        abortSignal: signal,
        ...(bareDeny && opts.stopOnBareDeny ? { endTurn: 'if-denied' as const } : {}),
      },
    )
    opts.onRun?.(run)
    result = await run.result
  }
  return result
}
