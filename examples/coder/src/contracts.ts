/**
 * Shared contracts of the `coder` example (docs/plans/P30-coder-example.md). Every module codes
 * against these types; change them only together with every implementer.
 *
 * Layering: `workspace/`, `shell/`, `permissions/`, `agents/`, `app/` never import Ink or React.
 * `ui/` and `print.ts` consume a {@link CoderController}.
 */
import type { Experimental_SandboxSession } from 'ai'
import type { HarnessRun, HarnessUIMessage, TurnResult } from 'eharness'
import type { FileSystem } from 'eharness/filesystem'

// ─── Tool names (stable order = prompt-cache prefix, see TOOL_ORDER) ─────────────────────────

export const TOOL = {
  read: 'read_file',
  list: 'list_files',
  grep: 'grep',
  glob: 'glob',
  edit: 'edit_file',
  write: 'write_file',
  delete: 'delete_file',
  bash: 'bash',
  todo: 'todo_write',
  agent: 'agent',
  exitPlan: 'exit_plan_mode',
  dirAccess: 'request_directory_access',
} as const
export type CoderToolName = (typeof TOOL)[keyof typeof TOOL]

/** Order of the tools in every request (AI SDK `toolOrder`); skill and MCP tools come after. */
export const TOOL_ORDER: readonly string[] = [
  TOOL.read,
  TOOL.list,
  TOOL.grep,
  TOOL.glob,
  TOOL.edit,
  TOOL.write,
  TOOL.delete,
  TOOL.bash,
  TOOL.todo,
  TOOL.agent,
  TOOL.exitPlan,
  TOOL.dirAccess,
]

/** Tools that never modify anything (allowed in plan mode and for read-only agents). */
export const READ_ONLY_TOOLS: readonly string[] = [
  TOOL.read,
  TOOL.list,
  TOOL.grep,
  TOOL.glob,
  TOOL.todo,
  'load_skill',
  'read_skill_file',
  'search_skills',
]

// ─── Configuration ───────────────────────────────────────────────────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]
/** `Shift+Tab` cycle. */
export const MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']

/** Claude-Code-style rule strings, e.g. `Bash(bun test *)`, `Edit(src/**)`, `Read(./.env)`. */
export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

/** One settings file (`~/.coder/settings.json`, `<root>/.coder/settings.json`, `…local.json`). */
export interface CoderSettings {
  model?: string
  contextWindow?: number
  permissions?: Partial<PermissionRules> & {
    defaultMode?: PermissionMode
    additionalDirectories?: string[]
  }
  /** MCP servers (M5); shape of `mcpServer()` transport configs, keyed by server name. */
  mcpServers?: Record<string, unknown>
}

export interface PrintOptions {
  prompt: string
  format: 'text' | 'json' | 'stream-json'
}

/** Settings files merged with the CLI flags. All paths are real, absolute paths. */
export interface CoderConfig {
  /** Real path (`realpath`) of the project root. */
  root: string
  /** `~/.coder` */
  userDir: string
  /** `~/.coder/projects/<sha256(root)[0:16]>`: sessions, tool outputs, audit log. */
  projectDataDir: string
  settingsFiles: { user: string; project: string; local: string }
  /** AI Gateway id or a model id the app maps to a provider. Default `anthropic/claude-sonnet-4.6`. */
  model: string
  /** Default 200_000. */
  contextWindow: number
  mode: PermissionMode
  rules: PermissionRules
  /** Real absolute paths of extra directories (`--add-dir`, settings). */
  additionalDirectories: string[]
  /** `--agents` JSON, already parsed. */
  cliAgents: Record<string, AgentDefinitionInput>
  /** Default 200. */
  maxSteps: number
  /** Default 2: subagent nesting depth below the main agent. */
  maxAgentDepth: number
  mcpServers: Record<string, unknown>
  print?: PrintOptions
  /** `--continue` / `--resume [id]`. `resume: true` = show a picker. */
  continueLast: boolean
  resume?: string | true
}

// ─── Workspace (workspace/) ──────────────────────────────────────────────────────────────────

/** A mount of the virtual tree: `/` → project root, `/@dirs/<name>/` → extra directories. */
export interface Mount {
  /** Virtual prefix ending in `/` (`'/'`, `'/@dirs/shared-lib/'`, `'/.coder/tool-outputs/'`). */
  virtual: string
  /** Real absolute directory. */
  real: string
  readonly: boolean
}

export interface Workspace {
  /** Real project root. */
  readonly root: string
  /** The composite FileSystem given to the `filesystem()` plugin (path guard inside). */
  readonly fs: FileSystem
  mounts(): Mount[]
  /** Virtual path → real path, or null when outside every mount / escaping by symlink. */
  toReal(virtualPath: string): Promise<string | null>
  /** Real path → virtual path, or null when not inside a mount. */
  toVirtual(realPath: string): string | null
  /** Mount a new directory (after approval). Returns its virtual prefix. */
  addDirectory(realPath: string): Promise<string>
}

// ─── Shell (shell/) ──────────────────────────────────────────────────────────────────────────

/** AI SDK's sandbox shape; `createLocalSandbox(root)` implements it over `child_process`. */
export type Sandbox = Experimental_SandboxSession

/** Transient data part `data-bashOutput` written by the bash tool while a command runs. */
export interface BashOutputData {
  toolCallId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

// ─── Permissions (permissions/) ──────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string
  input: unknown
  /** Name of the subagent making the call; undefined for the main agent. */
  agent?: string
}

export type PermissionDecision =
  | { status: 'approved'; rule?: string }
  | { status: 'user-approval'; rule?: string; reason?: string }
  | { status: 'denied'; rule?: string; reason: string }

export interface PermissionEngine {
  readonly mode: PermissionMode
  setMode(mode: PermissionMode): void
  /** Next mode of {@link MODE_CYCLE} (from any mode outside the cycle: `default`). */
  cycleMode(): PermissionMode
  /** Deterministic and side-effect free (called from `tool.approve`). */
  decide(call: ToolCallInfo, mode?: PermissionMode): PermissionDecision
  /** Rule to offer for "don't ask again" (e.g. `Bash(bun test *)`, `Edit`), if any. */
  suggestRule(call: ToolCallInfo): string | undefined
  /** Add an allow rule for this process (`session`) or persist it to settings.local.json (`project`). */
  allow(rule: string, scope: 'session' | 'project'): Promise<void>
  rules(): PermissionRules
  /** Tools a mode makes unavailable (plan mode: everything not read-only except exit_plan_mode). */
  inactiveTools(mode?: PermissionMode): string[]
  subscribe(listener: (mode: PermissionMode) => void): () => void
}

/** A question for the user, shown by the UI (main agent and subagents alike). */
export interface ApprovalRequest {
  /** Unique per question (the eharness approval id when there is one). */
  id: string
  agent?: string
  toolName: string
  input: unknown
  /** One line, e.g. `Bash: bun test`, `Edit src/app.ts`. */
  title: string
  /** Command, unified diff or plan text. */
  detail?: string
  /** Rule offered for "don't ask again". */
  suggestedRule?: string
}

export type ApprovalAnswer =
  | { approved: true; remember?: 'session' | 'project' }
  | { approved: false; feedback?: string }

/** In-process queue of questions for the user. Print mode answers everything with a denial. */
export interface ApprovalBroker {
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>
  pending(): ApprovalRequest[]
  answer(id: string, answer: ApprovalAnswer): void
  subscribe(listener: (pending: ApprovalRequest[]) => void): () => void
}

// ─── Agents (agents/) ────────────────────────────────────────────────────────────────────────

/** A subagent definition as written (frontmatter + body, or `--agents` JSON). */
export interface AgentDefinitionInput {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  /** `inherit` (default) or a model id. */
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  omitProjectMemory?: boolean
}

export interface AgentDefinition extends AgentDefinitionInput {
  name: string
  source: 'builtin' | 'cli' | 'project' | 'user'
  /** File it was loaded from (project/user). */
  file?: string
}

/** Preliminary output of the `agent` tool (the final output is the child's last text, a string). */
export interface AgentProgress {
  status: 'running' | 'done' | 'failed'
  agent: string
  description: string
  sessionId: string
  steps: number
  lastTool?: string
  text: string
}

// ─── Controller (app/) → consumed by ui/ and print.ts ────────────────────────────────────────

export type CoderMessage = HarnessUIMessage

export interface RunHooks {
  /** Every run the controller starts (the send, then each respond continuation), before it is consumed. The hook must consume `run.stream` (single consumer). */
  onRun(run: HarnessRun<CoderMessage>): void
}

export interface SessionSummary {
  id: string
  updatedAt: number
  firstPrompt: string
}

export interface CoderController {
  readonly config: CoderConfig
  readonly permissions: PermissionEngine
  readonly broker: ApprovalBroker
  readonly workspace: Workspace
  readonly sessionId: string
  /**
   * Run one user prompt to the end: send, then for every `tool-pending` stop ask the broker for
   * each pending approval, apply "don't ask again" rules, `respond()`, until the turn ends.
   * Resolves with the last turn's result. Never rejects for run errors.
   */
  run(text: string, hooks: RunHooks): Promise<TurnResult<CoderMessage>>
  /** Abort the running turn (Esc). */
  abort(): void
  messages(): Promise<CoderMessage[]>
  compact(): Promise<void>
  /** Start a fresh session (`/clear`). */
  clear(): Promise<void>
  /** Switch to a stored session (`/resume`). */
  resume(sessionId: string): Promise<void>
  sessions(): Promise<SessionSummary[]>
  setModel(model: string): void
  agents(): AgentDefinition[]
  /** Context and cost for the status bar. */
  stats(): Promise<{ contextTokens: number; contextWindow: number; costUsd?: number }>
  close(): Promise<void>
}
