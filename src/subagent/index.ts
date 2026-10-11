/**
 * `eharness/subagent`: the `subagent()` plugin (the `agent` tool, child sessions with three
 * approval strategies: inline, park, policy) and `subagentChild()` for `'park'` children.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/20-subagent-plugin.md
 */

export {
  type BackgroundReconcileEntry,
  type ReconcileBackgroundOptions,
  reconcileBackgroundChildren,
} from './background.ts'
export {
  AGENT_STOP_TOOL,
  SEND_MESSAGE_TOOL,
  type SubagentMessageLimits,
} from './messaging.ts'
export {
  AGENT_OUTPUT_TOOL,
  AGENT_TOOL,
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  SUBAGENT_DENIED,
  SUBAGENT_NO_CLIENT,
  SUBAGENT_NO_USER,
  type SubagentApprovalAnswer,
  type SubagentApprovalRequest,
  type SubagentCatalog,
  type SubagentChildInfo,
  type SubagentDefinition,
  type SubagentFile,
  type SubagentFilesOptions,
  type SubagentOptions,
  type SubagentProgress,
  type SubagentReconcileEntry,
  type SubagentRunData,
  subagent,
  subagentChild,
} from './plugin.ts'
export type { SubagentTask, SubagentTaskStatus, SubagentTasks } from './tasks.ts'
