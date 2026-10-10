/** Public types of `eharness/permissions` (spec 18). */

import type { GuardTranscriptEntry } from '../index.ts'

/**
 * How the engine decides when no rule does. `auto` hands the calls no rule or read-only check
 * settles to an {@link AutoClassifier} (spec 18 §12); it needs the engine's `classifier` option.
 *
 * @experimental The `auto` mode is Draft in 0.7: it may change in a minor release
 * (docs/engineering/api-stability.md). The other modes are not affected.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'auto'

/** Every mode, in the order of the table in spec 18 §3. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
  'auto',
]

/** Default order of {@link PermissionEngine.cycleMode}. */
export const DEFAULT_MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']

/**
 * The cycle with optional modes slotted in after `plan`: `bypassPermissions` first, `auto` last.
 * `dontAsk` is never part of a cycle. Pass the result as the engine's `modeCycle`.
 */
export function modeCycleFor(options: { bypass?: boolean; auto?: boolean }): PermissionMode[] {
  const cycle: PermissionMode[] = [...DEFAULT_MODE_CYCLE]
  if (options.bypass === true) cycle.push('bypassPermissions')
  if (options.auto === true) cycle.push('auto')
  return cycle
}

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
  | { status: 'approved'; rule?: string; auto?: 'allowed' }
  | { status: 'user-approval'; rule?: string; reason?: string; auto?: 'classify' | 'paused' }
  | { status: 'denied'; rule?: string; reason: string; auto?: 'blocked' }

/** The action an {@link AutoClassifier} reviews. */
export interface AutoAction {
  toolName: string
  input: unknown
  kind: ToolKind
  /** The command of a shell tool or the URL of a fetch tool, when there is one. */
  summary?: string
  /** Name of the (sub)agent making the call, when known. */
  agent?: string
}

/** What an {@link AutoClassifier} may read besides the action. */
export interface AutoClassifierContext {
  /**
   * The restricted transcript (user messages and earlier tool calls, never tool outputs), oldest
   * first; empty when the caller has none.
   */
  transcript: readonly GuardTranscriptEntry[]
  abortSignal?: AbortSignal
}

/**
 * A classifier verdict. `reason` is shown to the model when the action is blocked.
 *
 * @experimental Draft in 0.7: may change in a minor release (docs/engineering/api-stability.md).
 */
export interface AutoVerdict {
  decision: 'allow' | 'block'
  reason?: string
}

/**
 * Judges one action in `auto` mode. It must be fail-safe: throwing (or returning anything but a
 * well-formed verdict) blocks the action.
 *
 * @experimental Draft in 0.7: may change in a minor release (docs/engineering/api-stability.md).
 */
export type AutoClassifier = (
  action: AutoAction,
  ctx: AutoClassifierContext,
) => Promise<AutoVerdict> | AutoVerdict

/** Block counters of `auto` mode; `paused` means calls ask a person until one is approved. */
export interface AutoState {
  paused: boolean
  /** Blocks in a row (an allowed action resets it). */
  consecutive: number
  /** Blocks since the session started, or since the total limit last paused auto mode. */
  total: number
}

/** Something that happened in `auto` mode, for notices. */
export type AutoEvent =
  /** `reason` is short (the classifier's own, or why it was unavailable): for a notice. */
  /** `reason` is short (the classifier's own, or why it was unavailable): for a notice. */
  | { type: 'blocked'; toolName: string; reason: string; state: AutoState }
  | { type: 'paused'; cause: 'consecutive' | 'total'; state: AutoState }
  | { type: 'resumed'; state: AutoState }

/** Listener of {@link AutoEvent}s. */
export type AutoListener = (event: AutoEvent) => void

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
