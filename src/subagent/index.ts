/**
 * `eharness/subagent`: the `subagents()` plugin (the `agent` tool, child sessions with three
 * approval strategies: inline, park, policy) and `subagentChild()` for `'park'` children.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
export {
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  SUBAGENT_BACKGROUND_REPORT_CHARS,
  SUBAGENT_DENIED,
  SUBAGENT_NO_CLIENT,
  SUBAGENT_NO_USER,
  SUBAGENT_TOOL,
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
