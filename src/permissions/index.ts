/**
 * `eharness/permissions`: rule-based tool permissions — `Tool(spec)` rules with deny/ask/allow
 * precedence, modes (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`), shell
 * command analysis with read-only grammars and path containment, protected paths, plan mode and
 * output filtering. One engine, three deployment profiles (autonomous server, single-process CLI,
 * split web/server).
 *
 * @see docs/specs/18-permissions-plugin.md
 */
export { type ParsedCommand, parseCommand } from './command.ts'
export {
  createPermissionEngine,
  DEFAULT_BUILTIN_ASK,
  DEFAULT_PROTECTED_PATHS,
  DONT_ASK_REASON,
  type PermissionEngine,
  type PermissionEngineOptions,
  PLAN_MODE_REASON,
} from './engine.ts'
export { type ModeSource, type PermissionsPluginOptions, permissionsPlugin } from './plugin.ts'
export {
  isGlobArg,
  isReadOnlyCommand,
  isReadOnlySubcommand,
  READ_ONLY_COMMAND_NAMES,
  type ReadPaths,
  readPathArguments,
} from './readonly.ts'
export {
  domainSpecifierMatches,
  type MatchContext,
  type MatchRuleOptions,
  matchBashSpec,
  matchRule,
  type ParsedRule,
  parseRule,
} from './rules.ts'
export { DEFAULT_ALIASES, DEFAULT_TOOL_KINDS } from './tools.ts'
export {
  DEFAULT_MODE_CYCLE,
  type ListingFormat,
  type ModeListener,
  PERMISSION_MODES,
  type PermissionCall,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRoot,
  type PermissionRules,
  type ToolKind,
  type ToolKindSpec,
  type ToolKinds,
} from './types.ts'
