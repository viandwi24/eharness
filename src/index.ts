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
  AbortRequest,
  AbortRequestResult,
  ActiveTurn,
  ApprovalActor,
  ChildSessionInfo,
  CollectOptions,
  DeadInboxItem,
  EnqueueOptions,
  EnqueueResult,
  ForkOptions,
  HarnessKindTypes,
  HarnessRun,
  HarnessSession,
  InboxAdapter,
  InboxItem,
  InboxItemInput,
  InboxReleaseOptions,
  InboxStats,
  InjectOptions,
  KindData,
  KindName,
  MessageAdapter,
  ParentInfo,
  PendingResponse,
  ResolveWaitResult,
  SendInput,
  SendOptions,
  SendOptionsWithOutput,
  SerializedInput,
  SessionEvent,
  SessionLock,
  SessionOptions,
  SessionStateSnapshot,
  StateAdapter,
  SteerDelivery,
} from './agent/session-types.ts'
export type {
  AgentDataTypes,
  AgentKindTypes,
  AgentMessageOf,
  AgentStaticTools,
  ApprovalConfig,
  BudgetConfig,
  BudgetEstimateEvent,
  BudgetLedger,
  BudgetLedgerConfig,
  BudgetReservation,
  BudgetScopeStatus,
  CacheConfig,
  CompactionConfig,
  HarnessAgent,
  HarnessAgentConfig,
  InboxBackoffOptions,
  InboxRetryOptions,
  InputFilesConfig,
  LoopConfig,
  ModelSettings,
  ProgressConfig,
  PruneConfig,
  ToolErrorTextFn,
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
export { neutralizeTags } from './messages/framing.ts'
export { isUuidV7, uuidv7 } from './messages/ids.ts'
export {
  type CreateKindMessageOptions,
  createKindMessage,
  defineMessageKind,
  isKindMessage,
  type MessageKindDef,
} from './messages/kinds.ts'
export {
  CLIENT_TOOL_TIMED_OUT,
  DENIED_NEW_INPUT,
  FILE_UNAVAILABLE,
  FINAL_ANSWER_DESCRIPTION,
  FINAL_ANSWER_RECORDED,
  FLUSH_APPROVAL_DENIED,
  INTERRUPTED_CRASH,
  INTERRUPTED_TURN,
  INTERRUPTED_UNKNOWN,
  MAX_STEPS_WRAP_UP,
  NOT_EXECUTED_NEW_INPUT,
  OUTPUT_INSTRUCTION,
  OUTPUT_RETRY,
  PAGE_CONTEXT_PREAMBLE,
  PROGRESS_NUDGE,
  TOOL_OUTPUT_PRUNED,
  TOOL_OUTPUT_TRUNCATED,
  WAIT_CANCELLED_NEW_INPUT,
  WAIT_TIMED_OUT,
} from './messages/texts.ts'
export type {
  CompactionPayload,
  ContextStats,
  EventPayload,
  FlushPayload,
  HarnessDataTypes,
  HarnessMessageMeta,
  HarnessMetadata,
  HarnessUIMessage,
  HarnessUsageMeta,
  InferHarnessUIMessage,
  InputPartData,
  InstructionBlockStats,
  NoticePayload,
  OutputPartData,
  PendingClientTool,
  PendingExternal,
  PendingState,
  ProjectionContext,
  RewindPayload,
  StatusPartData,
  StopReason,
  ToolRisk,
  ToolSourceStats,
  TurnKind,
  TurnResult,
  UsagePartData,
  WaitResult,
  WaitTimeoutResult,
  WarningPartData,
} from './messages/types.ts'
export { lookupModel, modelsDevCatalog } from './models/catalog.ts'
export { computeCost, estimateStepCostUsd } from './models/cost.ts'
export type { ModelCatalog, ModelInfo, ModelPricing, TokenRates } from './models/types.ts'
export type { OutputSpec } from './output/types.ts'
export { definePlugin } from './plugin/define-plugin.ts'
export type {
  AddUsageInput,
  AddUsageOptions,
  AgentSetupContext,
  ApprovalDecision,
  CompactionBeforeEvent,
  CompactionBeforePatch,
  DataPartMap,
  HarnessContext,
  HarnessHooks,
  HarnessLogger,
  HarnessPlugin,
  HarnessServices,
  HookName,
  KindMap,
  PlainUsage,
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
export {
  type WrapHookNext,
  type WrapHookOverride,
  type WrapHookOverrides,
  type WrapPluginOverrides,
  type WrapSessionNext,
  wrapPlugin,
} from './plugin/wrap-plugin.ts'
export {
  type ExternalToolDef,
  externalTool,
  type WaitStart,
  type WaitStartEvent,
} from './registry/external.ts'
export type { SessionToolInfo } from './registry/inventory.ts'
export type {
  ClientToolDeclaration,
  ClientToolsOptions,
  PageContextEntry,
  PageContextOptions,
} from './registry/request-tools.ts'
export { type ToolHints, type ToolTraits, toolTraits } from './registry/risk.ts'
export { defineToolSource } from './registry/tool-source.ts'
export type { GuardTranscriptEntry } from './registry/transcript.ts'
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
export {
  type ChatRequestBody,
  type ChatRequestOptions,
  handleChatRequest,
} from './stream/chat-request.ts'

/** Package version of this build. */
export const version: string = '0.6.0'
