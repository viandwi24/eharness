/**
 * Drives a turn of the MAIN agent to its end: answers every `tool-pending` stop through the
 * approval broker (and `ask_user_question` through the broker's questions) and continues with
 * `respond()`. The children of the `agent` tool are driven by the library's `subagents()` plugin
 * with `approvals: 'inline'`; its `answer` callback is `agents/subagents.ts`.
 */
import type { HarnessRun, HarnessSession, TurnResult } from 'eharness'
import { answerOutput, pendingQuestions } from 'eharness/ask'
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

/** Options of {@link driveTurn}. */
export interface DriveOptions {
  session: HarnessSession<CoderMessage>
  broker: ApprovalBroker
  permissions: PermissionEngine
  /** Title/detail/suggested rule of a pending call (permissions/describe.ts). */
  describe(call: ToolCallInfo): Promise<{ title: string; detail?: string; suggestedRule?: string }>
  signal?: AbortSignal
  /** Called with every run (the first one and every respond continuation) before it is awaited; must consume run.stream if it wants the chunks. */
  onRun?(run: HarnessRun<CoderMessage>): void
  /**
   * A bare "No" (no feedback) on a prompt stops the turn: `respond(…, { endTurn: 'if-denied' })`
   * records the denial and ends the turn without a model call.
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
      const call: ToolCallInfo = { toolName: entry.toolName, input: entry.input }
      const description = await opts.describe(call)
      const request: ApprovalRequest = {
        id: entry.approvalId,
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
        if (entry.toolName === TOOL.exitPlan) {
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
    const stored: Record<string, unknown> = {}
    for (const call of pending.clientTools) {
      // the pending state carries the input; the stored part only when it was too large to copy
      if (call.inputTruncated) stored[call.toolCallId] = await storedInput(session, call.toolCallId)
    }
    const questions = pendingQuestions(pending, { storedInputs: stored })
    const asking = new Set(questions.map((q) => q.toolCallId))
    for (const call of pending.clientTools) {
      if (!asking.has(call.toolCallId)) {
        toolOutputs.push({
          toolCallId: call.toolCallId,
          errorText: 'Not supported in this client.',
        })
      }
    }
    for (const call of questions) {
      if (call.questions === undefined) {
        toolOutputs.push(answerOutput(call, null))
        continue
      }
      const request = { id: call.toolCallId, questions: call.questions }
      const asked = await withQuestionTimeout(
        (s) => broker.question(request, s),
        opts.questionTimeout?.() ?? 0,
        signal,
      )
      if (signal?.aborted) {
        session.abort()
        return result
      }
      toolOutputs.push(
        answerOutput(
          call,
          asked.result,
          asked.timedOut ? (asked.note ?? QUESTION_TIMEOUT_NOTE) : undefined,
        ),
      )
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
