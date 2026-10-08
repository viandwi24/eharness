/**
 * Drives a turn to its end: answers every `tool-pending` stop through the approval broker and
 * continues with `respond()`. Shared by the controller (main agent) and the `agent` tool (children).
 */
import type { HarnessRun, HarnessSession, TurnResult } from 'eharness'
import type {
  ApprovalBroker,
  ApprovalRequest,
  CoderMessage,
  PermissionEngine,
  ToolCallInfo,
} from '../contracts.ts'

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
}

const DENIED = 'Denied by the user.'

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
    const approvals: Array<{ id: string; approved: boolean; reason?: string }> = []
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
        approvals.push({ id: entry.approvalId, approved: true })
      } else {
        approvals.push({ id: entry.approvalId, approved: false, reason: answer.feedback || DENIED })
      }
    }
    const toolOutputs = pending.clientTools.map((c) => ({
      toolCallId: c.toolCallId,
      errorText: 'Not supported in this client.',
    }))
    run = session.respond({ approvals, toolOutputs }, { abortSignal: signal })
    opts.onRun?.(run)
    result = await run.result
  }
  return result
}
