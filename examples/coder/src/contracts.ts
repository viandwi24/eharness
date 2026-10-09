/**
 * Shared contracts of the `coder` example (docs/plans/P30-coder-example.md). Every module codes
 * against these types; change them only together with every implementer.
 *
 * Layering: `workspace/`, `permissions/`, `agents/`, `app/` never import Ink or React.
 * `ui/` and `print.ts` consume a {@link CoderController}.
 */
import type { FileUIPart } from 'ai'
import type { HarnessRun, HarnessUIMessage, TurnResult } from 'eharness'
import type { FileSystem } from 'eharness/filesystem'
import type { PermissionDecision, PermissionMode, PermissionRules } from 'eharness/permissions'
import type { ShellOutputData } from 'eharness/shell'
import type { SubagentProgress } from 'eharness/subagent'

// ─── Tool names ──────────────────────────────────────────────────────────────────────────────

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
  ask: 'ask_user_question',
  webFetch: 'web_fetch',
  webSearch: 'web_search',
  lsp: 'lsp',
} as const
export type CoderToolName = (typeof TOOL)[keyof typeof TOOL]

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
  TOOL.lsp,
]

// ─── Configuration ───────────────────────────────────────────────────────────────────────────

export type { PermissionDecision, PermissionMode, PermissionRules } from 'eharness/permissions'
export { DEFAULT_MODE_CYCLE as MODE_CYCLE, PERMISSION_MODES } from 'eharness/permissions'

/** One settings file (`~/.coder/settings.json`, `<root>/.coder/settings.json`, `…local.json`). */
export interface CoderSettings {
  model?: string
  /** Model provider; default: from the API keys in the environment (see `app/provider.ts`). */
  provider?: ModelProvider
  contextWindow?: number
  permissions?: Partial<PermissionRules> & {
    defaultMode?: PermissionMode
    additionalDirectories?: string[]
  }
  /** MCP servers (M5); shape of `mcpServer()` transport configs, keyed by server name. */
  mcpServers?: Record<string, unknown>
  /** UI palette. Default `dark`; `auto` reads `COLORFGBG`. */
  theme?: 'dark' | 'light' | 'auto'
  /** Output style name (`default`, `concise`, `explanatory`, `learning`, or a file in `.coder/output-styles/`). */
  outputStyle?: string
  /** Terminal bell / desktop notification when a turn ends or input is needed. Default `bell`. */
  notifications?: 'off' | 'bell' | 'desktop'
  /** Auto-dismiss unanswered `ask_user_question` dialogs after this many seconds (0 = never, default). */
  askUserQuestionTimeout?: number
  /** Footer status line: a shell command that receives the status JSON on stdin; first stdout line is shown. */
  statusLine?: { command: string }
  /** Next-prompt suggestions after each turn (a cheap model call). Default false. */
  promptSuggestions?: boolean
  /** Prompt editor mode. Default `normal`. */
  editorMode?: 'normal' | 'vim'
  /** Shell hooks on agent events (project hooks need trust). */
  hooks?: Partial<
    Record<HookEvent, Array<{ matcher?: string; command: string; timeoutMs?: number }>>
  >
  /** OS sandbox for the bash tool. */
  sandbox?: { enabled?: boolean; network?: boolean; allowWrite?: string[] }
  /** Language servers by name: command and file extensions. */
  lsp?: Record<string, { command: string[]; extensions: string[] }>
}

/** Events a settings hook can run on. */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'Notification'
  | 'SessionStart'

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
  /** Where model calls go (`--provider`, settings, else the API keys in the environment). */
  provider: ModelProvider
  /** Model id for {@link CoderConfig.provider}; default `anthropic/claude-sonnet-5.5` (OpenRouter) or `anthropic/claude-sonnet-4.6` (gateway). */
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
  /**
   * Project settings keys that were ignored because the project is not trusted yet
   * (`defaultMode`, `allow`, `additionalDirectories`, `mcpServers`, project agents and skills).
   * Empty when trusted or when the project file sets none of them.
   */
  untrusted: string[]
  /** Whether the project's `.coder/` content (settings, agents, skills) is trusted. */
  trusted: boolean
}

// ─── Workspace (workspace/) ──────────────────────────────────────────────────────────────────

/** A mount of the virtual tree: `/` → project root, `/@dirs/<name>/` → extra directories. */
export interface Mount {
  /** Virtual prefix ending in `/` (`'/'`, `'/@dirs/shared-lib/'`, `'/.eharness/tool-outputs/'`). */
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

// ─── Shell (`eharness/shell`) ────────────────────────────────────────────────────────────────

/** Transient data part `data-shell.output` written by the bash tool while a command runs. */
export type BashOutputData = ShellOutputData

// ─── Permissions (permissions/) ──────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string
  input: unknown
  /** Name of the subagent making the call; undefined for the main agent. */
  agent?: string
}

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
  /** Add a rule of any kind (`/permissions allow|ask|deny <rule>`); `project` persists to settings.local.json. */
  addRule(kind: keyof PermissionRules, rule: string, scope: 'session' | 'project'): Promise<void>
  /** Remove a rule from the in-memory rules and, when present, from settings.local.json. Returns whether it existed. */
  removeRule(kind: keyof PermissionRules, rule: string): Promise<boolean>
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

/**
 * The user's answer. `note` (Tab on "Yes") is sent to the model after the tool result; `feedback`
 * (Tab on "No") is the denial reason. A bare "No" from the main agent's prompt stops the turn.
 */
export type ApprovalAnswer =
  | {
      approved: true
      remember?: 'session' | 'project'
      note?: string
      /** Plan approvals (`exit_plan_mode`): the mode to switch to (`acceptEdits` or `default`). */
      mode?: PermissionMode
    }
  | { approved: false; feedback?: string }

/** One multiple-choice question of the `ask_user_question` tool. */
export interface Question {
  /** The full question, ends with `?`. */
  question: string
  /** Short chip label (max 12 chars), e.g. `Auth method`. */
  header: string
  /** 2–4 options; an "Other" free-text row is always added by the UI. */
  options: Array<{ label: string; description?: string }>
  /** Checkbox (several answers) instead of radio (exactly one). */
  multiSelect: boolean
}

/** A batch of 1–4 questions from the model, shown as one dialog with a tab per question. */
export interface QuestionRequest {
  id: string
  agent?: string
  questions: Question[]
}

export interface QuestionAnswer {
  /** Same order as the request's questions. */
  answers: Array<{
    question: string
    /** Labels of the chosen options (radio: exactly one unless `other` is set). */
    selected: string[]
    /** Text typed in the "Other" row. */
    other?: string
    /** Free notes the user attached to this question. */
    notes?: string
  }>
}

/** `null` = the user dismissed the dialog (Esc) without answering. */
export type QuestionResult = QuestionAnswer | null

/** In-process queue of questions for the user. Print mode answers everything with a denial. */
export interface ApprovalBroker {
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>
  pending(): ApprovalRequest[]
  answer(id: string, answer: ApprovalAnswer): void
  /** Ask the user a batch of questions (`ask_user_question`). Abort resolves `null`. */
  question(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionResult>
  pendingQuestions(): QuestionRequest[]
  answerQuestion(id: string, result: QuestionResult): void
  /** Fires on every change of approvals or questions. */
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
export type AgentProgress = SubagentProgress

// ─── Models, thinking, context (app/) → consumed by ui/ ─────────────────────────────────────

/** AI SDK `reasoning` levels (`LanguageModelCallOptions['reasoning']`), shown as "thinking". */
export type ThinkingLevel =
  | 'provider-default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

/** Where model calls go: OpenRouter (`OPENROUTER_API_KEY`) or the AI Gateway (`AI_GATEWAY_API_KEY`). */
export type ModelProvider = 'openrouter' | 'gateway'

/** One entry of the model picker. */
export interface ModelOption {
  /** Id passed to the provider, e.g. `anthropic/claude-sonnet-4.6`. */
  id: string
  /** Display name. */
  name: string
  provider: ModelProvider
  contextWindow?: number
  maxOutputTokens?: number
  /** USD per 1M tokens. */
  pricing?: { input: number; output: number; cacheRead?: number }
  /** Supports reasoning effort ("thinking"). */
  reasoning: boolean
  /** Supports tool calls (models without tools are not usable by the agent). */
  tools: boolean
  description?: string
}

/** One slice of the context window for the `/context` page. */
export interface ContextCategory {
  key: 'system' | 'tools' | 'mcp' | 'memory' | 'skills' | 'messages'
  label: string
  tokens: number
}

/** Everything the `/context` page shows. Token counts are the core's calibrated estimates. */
export interface ContextDetails {
  model: string
  provider: ModelProvider
  window: number
  /** Estimated tokens of the next request. */
  used: number
  /** `window - used`, never negative. */
  free: number
  /** Auto-compaction threshold in tokens (`summarizeAt`). */
  summarizeAt: number
  /** Hard limit of the context guard in tokens. */
  hardLimit: number
  /** `window - summarizeAt`: space kept free for compaction. */
  autocompactBuffer: number
  categories: ContextCategory[]
  /** Tool definitions by estimated size, largest first. */
  tools: Array<{ name: string; tokens: number; source: 'builtin' | 'mcp' | 'skill' }>
  /** Project memory files (AGENTS.md …) by estimated size. */
  memoryFiles: Array<{ path: string; tokens: number }>
  messages: { count: number; user: number; assistant: number; toolCalls: number }
  lastCompaction?: { before: number; after: number; at: number }
  pruned?: { outputs: number; chars: number }
}

/** Token and cost totals of the session for `/cost` and the footer. */
export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  turns: number
  /** Estimated USD; absent when the model is not priced. */
  costUsd?: number
  /** Wall-clock time of all turns in this process. */
  durationMs: number
}

/** Everything the `/status` page shows. */
export interface StatusInfo {
  version: string
  eharnessVersion: string
  cwd: string
  provider: ModelProvider
  model: string
  thinking: ThinkingLevel
  mode: PermissionMode
  sessionId: string
  mounts: Mount[]
  trusted: boolean
  untrusted: string[]
  memoryFile?: string
  mcpServers: string[]
  agents: number
  settingsFiles: Array<{ path: string; exists: boolean }>
  /** The OS sandbox of the bash tool: `enabled` is true only when it is on AND the platform tool works. */
  sandbox: { enabled: boolean; kind: string; network: boolean }
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
  /** Set by `/rename`. */
  name?: string
}

/** A point the conversation and/or code can be rewound to: just before a user prompt. */
export interface RewindPoint {
  /** The user message id. */
  messageId: string
  text: string
  at: number
  /** Files the agent changed from this point on (they would be restored). */
  files: string[]
}

export interface RewindResult {
  /** Root-relative paths restored to their content before the point. */
  restoredFiles: string[]
  /** New session id when the conversation was rewound (the old session stays resumable). */
  sessionId?: string
  /** The prompt text of the point, to put back into the input. */
  prompt: string
}

/** A shell command or subagent running in the background. */
export interface BackgroundTask {
  id: string
  kind: 'shell' | 'agent'
  label: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  /** Last lines of output (shell) or of the agent's text. */
  tail: string
}

/** One editable setting for the `/config` page. */
export interface SettingView {
  key: string
  label: string
  description: string
  type: 'boolean' | 'enum' | 'number' | 'string'
  options?: string[]
  value: unknown
  /** Where the current value comes from. */
  source: 'default' | 'user' | 'project' | 'local' | 'flag'
}

export interface DoctorCheck {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

/** One changed file of `git status` for the `/diff` page. */
export interface DiffFile {
  /** Path relative to the project root. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  added: number
  removed: number
  /** Unified diff (empty for binary files). */
  patch: string
  binary: boolean
  /** The agent edited this file in the current session (from `data-filesystem.change` parts). */
  editedByAgent: boolean
}

export interface DiffResult {
  /** False when the project is not a git repository (then only agent edits are listed). */
  git: boolean
  branch?: string
  files: DiffFile[]
}

/** A custom slash command (`.coder/commands/*.md`, `~/.coder/commands/*.md`) or a skill. */
export interface CustomCommand {
  /** Without the slash. */
  name: string
  description: string
  argumentHint?: string
  source: 'project' | 'user' | 'skill'
}

/** Result of {@link CoderController.steer}. */
export type SteerResult =
  /** Delivered into the running turn at its next step boundary. */
  | { delivered: 'step' }
  /** No turn was running any more: it ran as a turn of its own, driven with the given hooks. */
  | { delivered: 'turn'; result: TurnResult<CoderMessage> }

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
  run(
    text: string,
    hooks: RunHooks,
    opts?: { files?: FileUIPart[] },
  ): Promise<TurnResult<CoderMessage>>
  /** Abort the running turn (Esc). */
  abort(): void
  messages(): Promise<CoderMessage[]>
  /** Stored messages of another session of this project, e.g. a subagent child (`AgentProgress.sessionId`). */
  messagesOf(sessionId: string): Promise<CoderMessage[]>
  /** Summarize the conversation now; `instructions` focus the summary. */
  compact(instructions?: string): Promise<void>
  /** Start a fresh session (`/clear`). */
  clear(): Promise<void>
  /** Switch to a stored session (`/resume`). */
  resume(sessionId: string): Promise<void>
  sessions(): Promise<SessionSummary[]>
  /**
   * Run a command directly in the project root through the sandbox (`!command` shell mode). No
   * model is involved and there is no approval: the user typed it. Output (stdout and stderr,
   * capped like the bash tool) is returned; `exitCode` is null when the command was aborted.
   */
  shell(command: string, signal?: AbortSignal): Promise<{ output: string; exitCode: number | null }>
  setModel(model: string): void
  /** Current model id (changes with {@link CoderController.setModel}; takes effect at the next turn). */
  readonly model: string
  readonly provider: ModelProvider
  /** Current thinking level (default `provider-default`); applies to the main agent and subagents. */
  readonly thinking: ThinkingLevel
  setThinking(level: ThinkingLevel): void
  /** Models for the picker (OpenRouter catalog when available, cached), tool-capable first. */
  models(): Promise<ModelOption[]>
  contextDetails(): Promise<ContextDetails>
  usage(): Promise<UsageSummary>
  status(): Promise<StatusInfo>
  /**
   * Send a queued message into the running turn (steer). If the turn ended meanwhile, the
   * message runs as its own turn with `hooks` (approvals included), like {@link CoderController.run}.
   */
  steer(text: string, hooks: RunHooks): Promise<SteerResult>
  // ─── sessions and conversation ───
  rewindPoints(): Promise<RewindPoint[]>
  rewind(messageId: string, what: 'conversation' | 'code' | 'both'): Promise<RewindResult>
  /** Copy the conversation into a new session and switch to it. Returns the new id. */
  branch(name?: string): Promise<string>
  rename(name: string): Promise<void>
  readonly sessionName: string | undefined
  /** The conversation as plain text (`/export`). */
  exportText(): Promise<string>
  /** Text of the n-th latest assistant response (1 = latest), for `/copy`. */
  assistantText(n?: number): Promise<string | undefined>
  /** Side question answered from the current context, not added to the history (`/btw`). */
  sideQuestion(
    question: string,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string>
  /** One-line recap of the session (`/recap`, max 400 chars). */
  recap(): Promise<string>
  /** A suggested next prompt after the last turn, when `promptSuggestions` is on. */
  suggestNext(): Promise<string | undefined>
  // ─── workspace and memory ───
  addDirectory(path: string): Promise<string>
  memoryFiles(): Promise<
    Array<{ path: string; real: string; exists: boolean; scope: 'project' | 'user' }>
  >
  // ─── background tasks ───
  tasks(): BackgroundTask[]
  stopTask(id: string): Promise<void>
  taskOutput(id: string): Promise<string>
  onTasks(listener: (tasks: BackgroundTask[]) => void): () => void
  // ─── settings and diagnostics ───
  settings(): Promise<SettingView[]>
  /** Write a setting to the user or project-local settings file and apply it when possible. */
  updateSetting(key: string, value: unknown, scope: 'user' | 'local'): Promise<void>
  /** The merged value of a UI-relevant setting (theme, notifications, editorMode, statusLine…). */
  setting<K extends keyof CoderSettings>(key: K): CoderSettings[K]
  outputStyles(): Promise<Array<{ name: string; description: string }>>
  doctor(): Promise<DoctorCheck[]>
  /** Output of the `statusLine` command (first line), or undefined. */
  statusLineText(): Promise<string | undefined>
  /** Prompt history, newest last, persisted across sessions (`~/.coder/history.jsonl`). */
  history(opts?: { allProjects?: boolean; limit?: number }): Promise<string[]>
  addHistory(text: string): Promise<void>
  /** Working-tree changes for the `/diff` page. */
  diff(): Promise<DiffResult>
  /** Custom commands and invocable skills, for `/` completion. */
  commands(): Promise<CustomCommand[]>
  /** The prompt a custom command or skill invocation sends (`$ARGUMENTS` substituted). */
  expandCommand(name: string, args: string): Promise<string>
  agents(): AgentDefinition[]
  /** Context and cost for the status bar. */
  stats(): Promise<{ contextTokens: number; contextWindow: number; costUsd?: number }>
  close(): Promise<void>
}
