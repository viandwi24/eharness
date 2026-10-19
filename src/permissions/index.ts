/**
 * `eharness/permissions`: rule-based tool permissions — `Tool(spec)` rules with deny/ask/allow
 * precedence, modes (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, `auto`), shell
 * command analysis with read-only grammars and path containment, protected paths, plan mode and
 * output filtering. One engine, three deployment profiles (autonomous server, single-process CLI,
 * split web/server).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/18-permissions-plugin.md
 */
export {
  type ModelClassifierOptions,
  modelClassifier,
} from './classifier.ts'
export {
  AUTO_PAUSED_REASON,
  createPermissionEngine,
  DEFAULT_PROTECTED_PATHS,
  type DecideOptions,
  DONT_ASK_REASON,
  type PermissionEngine,
  type PermissionEngineOptions,
  PLAN_MODE_REASON,
} from './engine.ts'
export { type ModeSource, type PermissionsOptions, permissions } from './plugin.ts'
export { isReadOnlyCommand } from './readonly.ts'
export {
  domainSpecifierMatches,
  type MatchContext,
  type MatchRuleOptions,
  matchRule,
  type ParsedRule,
  parseRule,
} from './rules.ts'
export { DEFAULT_TOOL_KINDS } from './tools.ts'
export {
  type AutoAction,
  type AutoClassifier,
  type AutoClassifierContext,
  type AutoEvent,
  type AutoListener,
  type AutoState,
  type AutoVerdict,
  ClassifierUnavailableError,
  DEFAULT_MODE_CYCLE,
  type ListingFormat,
  type ModeListener,
  modeCycleFor,
  PERMISSION_MODES,
  type PermissionCall,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRoot,
  type PermissionRules,
  type RuleChange,
  type RuleScope,
  type ToolKind,
  type ToolKindSpec,
  type ToolKinds,
} from './types.ts'
