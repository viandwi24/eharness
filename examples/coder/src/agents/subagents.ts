/**
 * The app's half of the `agent` tool. The tool itself is the library's `subagents()` plugin with
 * `approvals: 'inline'`: it runs the child session, streams its progress and carries the child's
 * usage to the parent turn. When the child needs a person (an approval, a client tool) the
 * plugin calls `answer`; this one asks the same broker the main agent uses, labelled with the
 * subagent's name, and applies "don't ask again".
 */
import type { SubagentApprovalAnswer, SubagentApprovalRequest } from 'eharness/subagent'
import type {
  ApprovalBroker,
  ApprovalRequest,
  PermissionEngine,
  ToolCallInfo,
} from '../contracts.ts'

/** Dependencies of {@link subagentAnswer}. */
export interface SubagentAnswerDeps {
  broker: ApprovalBroker
  permissions: PermissionEngine
  /** Title/detail/suggested rule of a pending call (permissions/describe.ts). */
  describe(call: ToolCallInfo): Promise<{ title: string; detail?: string; suggestedRule?: string }>
}

/** The `answer` callback of `subagents({ approvals: 'inline' })`. */
export function subagentAnswer(
  deps: SubagentAnswerDeps,
): (request: SubagentApprovalRequest, signal: AbortSignal) => Promise<SubagentApprovalAnswer> {
  return async (request, signal) => {
    // only the main agent has `ask_user_question`; a child has no way to show anything else
    if (request.type === 'client-tool') return { errorText: 'Not supported in this client.' }
    const call: ToolCallInfo = {
      toolName: request.toolName,
      input: request.input,
      agent: request.agent,
    }
    const description = await deps.describe(call)
    const ask: ApprovalRequest = {
      id: request.approvalId,
      agent: request.agent,
      toolName: request.toolName,
      input: request.input,
      title: description.title,
      detail: description.detail,
      suggestedRule: description.suggestedRule,
    }
    const answer = await deps.broker.ask(ask, signal)
    if (!answer.approved) return { approved: false, reason: answer.feedback || undefined }
    if (answer.remember !== undefined && ask.suggestedRule !== undefined) {
      await deps.permissions.allow(ask.suggestedRule, answer.remember)
    }
    const note = answer.note?.trim()
    return { approved: true, ...(note ? { note } : {}) }
  }
}
