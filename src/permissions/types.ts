/** Public types of `eharness/permissions` (spec 18). */

/** How the engine decides when no rule does. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'

/** Every mode, in the order of the table in spec 18 §3. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]

/** Default order of {@link PermissionEngine.cycleMode}. */
export const DEFAULT_MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']

/** Rule strings (`Tool` or `Tool(specifier)`, spec 18 §2) by decision. */
export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

/**
 * One directory of the virtual tree the file tools address. `virtual` is the prefix the tools
 * use (`'/'`, `'/@dirs/shared/'`), `real` the POSIX path rules and shell commands use for the same
 * place. With a purely virtual file system pass the same string for both.
 */
export interface PermissionRoot {
  /** Virtual prefix; a trailing `/` is added when missing. */
  virtual: string
  /** Absolute POSIX path of the directory in the namespace rules and shell commands use. */
  real: string
  /** Writes are denied (`That directory is read-only.`). Default `false`. */
  readonly?: boolean
  /**
   * Shell commands may read here without asking (a "working directory"). Default `true`; set
   * `false` for a mount that only holds tool outputs.
   */
  workingDir?: boolean
}

/** A tool call as the engine sees it. */
export interface PermissionCall {
  toolName: string
  input: unknown
  /** Name of the (sub)agent making the call; informational. */
  agent?: string
}

/** The engine's answer; the plugin maps it onto the core's `ToolApprovalStatus` (spec 11 §3). */
export type PermissionDecision =
  | { status: 'approved'; rule?: string }
  | { status: 'user-approval'; rule?: string; reason?: string }
  | { status: 'denied'; rule?: string; reason: string }

/**
 * What a tool does, which decides how its calls are analysed:
 *
 * | kind | meaning |
 * |---|---|
 * | `read` | reads files; `Read(...)` rules apply to its path |
 * | `write` | creates, edits or deletes files; `Edit(...)` rules apply to its path |
 * | `shell` | runs a shell command (parsed, read-only grammars, redirects) |
 * | `fetch` | fetches a URL; `WebFetch(domain:...)` rules |
 * | `search` | a network search without a URL (`WebSearch`) |
 * | `agent` | starts a subagent; `Agent(name)` rules; approved by default |
 * | `ask` | asks the user a question; never gated by ask rules; approved |
 * | `plan-exit` | `exit_plan_mode`: asks in plan mode, denied elsewhere |
 * | `safe` | no side effects beyond the session (todos, skills); approved in every mode |
 * | `other` | anything else (MCP tools, custom tools); asks, denied in plan mode |
 */
export type ToolKind =
  | 'read'
  | 'write'
  | 'shell'
  | 'fetch'
  | 'search'
  | 'agent'
  | 'ask'
  | 'plan-exit'
  | 'safe'
  | 'other'

/** How the output of a listing tool is parsed to hide paths a `Read` rule protects. */
export type ListingFormat = 'grep' | 'list' | 'paths'

/** Describes one tool to the engine. */
export interface ToolKindSpec {
  kind: ToolKind
  /**
   * `read` / `write`: input field(s) holding the virtual path; the first one present wins
   * (`'path'`, or `['path', 'prefix']`).
   */
  pathField?: string | readonly string[]
  /** `read`: the path used when the input has none (`'/'` for `list_files`, `grep`, `glob`). */
  defaultPath?: string
  /** `shell`: input field holding the command. Default `command`. */
  commandField?: string
  /** `fetch`: input field holding the URL. Default `url`. */
  urlField?: string
  /** `agent`: input field matched by `Agent(name)`. Default `subagent_type`. */
  nameField?: string
  /** `read`: how to find the paths in the tool's text output (see `filterOutputs`). */
  listing?: ListingFormat
  /**
   * Every call asks the user (`user-approval`) in every mode, `bypassPermissions` included, and
   * no allow rule approves it; `dontAsk` turns the ask into a denial and deny rules still deny.
   * For tools that must always involve a human (directory access, payments, deploys). Ignored
   * for the `ask` and `plan-exit` kinds.
   */
  alwaysAsk?: boolean
}

/** Where a rule change lives: `session` rules are not stored, `project` rules go to `persist`. */
export type RuleScope = 'session' | 'project'

/** One rule change, passed to `persist` (spec 18 §2). */
export interface RuleChange {
  op: 'add' | 'remove'
  kind: keyof PermissionRules
  rule: string
  scope: RuleScope
}

/** Tool name to its description. */
export type ToolKinds = Record<string, ToolKindSpec>

/** Listener of mode changes. */
export type ModeListener = (mode: PermissionMode) => void
