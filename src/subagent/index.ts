/**
 * `eharness/subagent`: the `subagents()` plugin (the `agent` tool, child sessions with three
 * approval strategies: inline, park, policy) and `subagentChild()` for `'park'` children.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
export {
  AGENT_MESSAGE_INSTRUCTIONS,
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_NAME_PATTERN,
  AGENT_STOP_TOOL,
  SEND_MESSAGE_TOOL,
  type SubagentMessageLimits,
} from './messaging.ts'
export {
  AGENT_OUTPUT_PAGE_CHARS,
  AGENT_OUTPUT_TOOL,
  AGENT_REPORT_MAX_CHARS,
  AGENT_TOOL,
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  SUBAGENT_DENIED,
  SUBAGENT_NO_CLIENT,
  SUBAGENT_NO_USER,
  type SubagentApprovalAnswer,
  type SubagentApprovalRequest,
  type SubagentCatalog,
  type SubagentDefinition,
  type SubagentProgress,
  type SubagentReconcileEntry,
  type SubagentRunData,
  type SubagentsOptions,
  subagentChild,
  subagents,
  subagentWaitId,
} from './plugin.ts'
export type { SubagentTask, SubagentTaskStatus, SubagentTasks } from './tasks.ts'
