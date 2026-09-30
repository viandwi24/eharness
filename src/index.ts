/**
 * eharness core API.
 *
 * Every public symbol is re-exported here explicitly (no `export *`). Subpath modules
 * (`eharness/filesystem`, `eharness/testing`, …) import core only through this file.
 *
 * @see docs/architecture.md#2-package--exports
 */

export { defineHarnessAgent } from './agent/define-agent.ts'
export type {
  ActiveTurn,
  ApprovalActor,
  HarnessKindTypes,
  HarnessRun,
  HarnessSession,
  InjectOptions,
  KindData,
  KindName,
  MessageAdapter,
  PendingResponse,
  SendInput,
  SendOptions,
  SessionEvent,
  SessionLock,
  SessionOptions,
  SessionStateSnapshot,
  StateAdapter,
} from './agent/session-types.ts'
export type {
  AgentDataTypes,
  AgentKindTypes,
  AgentMessageOf,
  AgentStaticTools,
  ApprovalConfig,
  BudgetConfig,
  CacheConfig,
  CompactionConfig,
  HarnessAgent,
  HarnessAgentConfig,
  LoopConfig,
  ModelSettings,
  ProgressConfig,
  ToolOutputConfig,
} from './agent/types.ts'
export {
  HarnessError,
  type HarnessErrorCode,
  type HarnessErrorOptions,
  type HarnessNoticeCode,
  HarnessToolError,
  type HarnessWarning,
  isHarnessError,
  type WarningCode,
} from './errors.ts'
export { type DataChunk, type DataPartDef, defineDataPart } from './messages/data-parts.ts'
export { isUuidV7, uuidv7 } from './messages/ids.ts'
export {
  type CreateKindMessageOptions,
  createKindMessage,
  defineMessageKind,
  isKindMessage,
  type MessageKindDef,
} from './messages/kinds.ts'
export {
  DENIED_NEW_INPUT,
  INTERRUPTED_CRASH,
  INTERRUPTED_TURN,
  INTERRUPTED_UNKNOWN,
  MAX_STEPS_WRAP_UP,
  NOT_EXECUTED_NEW_INPUT,
  PROGRESS_NUDGE,
  TOOL_OUTPUT_TRUNCATED,
} from './messages/texts.ts'
export type {
  CompactionPayload,
  ContextStats,
  EventPayload,
  HarnessDataTypes,
  HarnessMessageMeta,
  HarnessMetadata,
  HarnessUIMessage,
  HarnessUsageMeta,
  InferHarnessUIMessage,
  InputPartData,
  NoticePayload,
  PendingState,
  ProjectionContext,
  RewindPayload,
  StatusPartData,
  StopReason,
  ToolRisk,
  TurnKind,
  TurnResult,
  UsagePartData,
  WarningPartData,
} from './messages/types.ts'
export { lookupModel, modelsDevCatalog } from './models/catalog.ts'
export { computeCost } from './models/cost.ts'
export type { ModelCatalog, ModelInfo, ModelPricing, TokenRates } from './models/types.ts'
export { definePlugin } from './plugin/define-plugin.ts'
export type {
  AddUsageOptions,
  AgentSetupContext,
  ApprovalDecision,
  DataPartMap,
  HarnessContext,
  HarnessHooks,
  HarnessLogger,
  HarnessPlugin,
  HarnessServices,
  HookName,
  KindMap,
  PluginContribution,
  PluginDef,
  PluginState,
  PluginStreamWriter,
  SessionContribution,
  StepEndEvent,
  StepPrepareEvent,
  StepPreparePatch,
  TurnInfo,
} from './plugin/types.ts'
export { defineToolSource } from './registry/tool-source.ts'
export type {
  InstructionFn,
  InstructionInput,
  Skill,
  SkillDoc,
  SkillFileContent,
  SkillMeta,
  SkillSource,
  ToolInput,
  ToolSource,
  ToolSourceDef,
  ToolsInput,
} from './registry/types.ts'
export {
  defineSkill,
  defineSkillSource,
  parseSkillMarkdown,
  validateSkillPath,
} from './skills/index.ts'
export { type ChatRequestBody, handleChatRequest } from './stream/chat-request.ts'

/** Package version of this build. */
export const version: string = '0.2.0'
