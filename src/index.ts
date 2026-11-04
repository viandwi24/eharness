/**
 * eharness core API.
 *
 * Every public symbol is re-exported here explicitly (no `export *`). Subpath modules
 * (`eharness/filesystem`, `eharness/testing`, …) import core only through this file.
 *
 * **Stable:** accepted API; changes follow docs/engineering/api-stability.md. Parts marked
 * `@experimental` (model catalog and cost, `createJudge`, `observe`, stream resume) are Draft.
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
  CompactOptions,
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
  RecoverResult,
  ResolveWaitResult,
  SendInput,
  SendOptions,
  SendOptionsWithOutput,
  SerializedInput,
  SessionBusy,
  SessionEvent,
  SessionLock,
  SessionOptions,
  SessionPeek,
  SessionStateSnapshot,
  SessionUsage,
  StateAdapter,
  SteerDelivery,
  StreamLogAdapter,
  StreamLogKey,
  StreamLogRead,
  StreamLogStatus,
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
  HooksConfig,
  InboxBackoffOptions,
  InboxRetryOptions,
  InputFilesConfig,
  LoopConfig,
  ModelSettings,
  ObserveCountName,
  ObserveEvent,
  ObserveScope,
  ObserveSpanName,
  ProgressConfig,
  PruneConfig,
  ResolveInputFile,
  ToolErrorTextFn,
  ToolOutputConfig,
  ToolSourcesConfig,
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
export {
  compileGitignorePattern,
  compileGlobRegExp,
  escapeRegExp,
  expandBraces,
  type GitignoreLine,
  GLOB_MAX_BRACE_ALTERNATIVES,
  GLOB_MAX_DOUBLE_STARS,
  GLOB_MAX_STARS,
  type GlobOptions,
  type GlobRegExpResult,
} from './internal/glob.ts'
export {
  collapseSegments,
  foldSegment,
  MAX_ROOTED_PATH_LENGTH,
  normalizeRootedPath,
} from './internal/path-segments.ts'
export { isPrivateHost } from './internal/private-host.ts'
export {
  GREP_MAX_PATTERN,
  GREP_PATTERN_RULE,
  GREP_SCAN_CHARS,
  isLiteralPattern,
  statelessPattern,
  unsafePatternReason,
} from './internal/regex-safety.ts'
export { errorText, isRecord } from './internal/util.ts'
export {
  createJudge,
  DEFAULT_JUDGE_MAX_CALL_CHARS,
  type Judge,
  type JudgeCacheEntry,
  type JudgeCall,
  type JudgeCallRef,
  type JudgeContext,
  type JudgeCoordinator,
  type JudgeLimits,
  type JudgeOptions,
  type JudgeOutcome,
  type JudgeParticipant,
  type JudgeResult,
  type JudgeRole,
  type JudgeStore,
  type JudgeTightenAnswer,
  JudgeUnavailableError,
  type JudgeVerdict,
  judgeCoordinator,
} from './judge/index.ts'
export { isLongRunCheckpoint, LONG_RUN_CHECKPOINT_STOP } from './loop/long-run-stop.ts'
export { type DataChunk, type DataPartDef, defineDataPart } from './messages/data-parts.ts'
export {
  neutralizeTags,
  UNTRUSTED_CONTENT_INSTRUCTIONS,
  type UntrustedContentOptions,
  untrustedContent,
} from './messages/framing.ts'
export { isUuidV7, uuidv7 } from './messages/ids.ts'
export {
  type CreateKindMessageOptions,
  createKindMessage,
  defineMessageKind,
  isKindMessage,
  type MessageKindDef,
} from './messages/kinds.ts'
export { stripLeakedToolMarkup } from './messages/leaked-markup.ts'
export { messageToChunks } from './messages/replay.ts'
export {
  CLIENT_TOOL_TIMED_OUT,
  DENIED_NEW_INPUT,
  FILE_UNAVAILABLE,
  FINAL_ANSWER_RECORDED,
  FLUSH_APPROVAL_DENIED,
  INTERRUPTED_CRASH,
  INTERRUPTED_TURN,
  INTERRUPTED_UNKNOWN,
  NOT_EXECUTED_NEW_INPUT,
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
export { lookupModel, modelsDevCatalog, openRouterCatalog } from './models/catalog.ts'
export type { CostSource } from './models/cost.ts'
export {
  computeCost,
  estimateStepCostUsd,
  providerReportedCost,
  settledCostOf,
} from './models/cost.ts'
export type {
  ModelCallEvent,
  ModelCallKind,
  ModelCallRecord,
  ModelCallToolCall,
} from './models/observe.ts'
export { observeModel } from './models/observe.ts'
export type {
  ModelCatalog,
  ModelInfo,
  ModelPricing,
  ModelThinking,
  ThinkingLevel,
  TokenRates,
} from './models/types.ts'
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
  TurnSource,
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
export { type ToolFieldOverrides, withToolExecute, withToolFields } from './registry/tool-copy.ts'
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
  handleResumeRequest,
  type ResumeRequestOptions,
} from './stream/chat-request.ts'

/** Package version of this build. */
export const version: string = '0.10.0'
