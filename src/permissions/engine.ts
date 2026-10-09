/**
 * The permission engine: decides every tool call from rules and the mode (spec 18).
 *
 * Evaluation order: deny rules, plan-mode gate, protected paths, ask rules, allow rules, built-in
 * ask rules (`.env*` reads, overridable by an allow rule), then the mode default.
 *
 * Read-only shell commands (see `readonly.ts`: per-command argument grammars) are not approved
 * blindly: their path arguments (and `<` redirects) are resolved lexically against the project
 * root. They auto-approve only when every path is inside a working directory, none uses an
 * unresolvable expansion (`$VAR` anywhere, `~user`, brace expansion, `xargs` stdin) and none
 * matches a `Read` rule. A `Read` deny match denies the command, a `Read` ask match (including the
 * built-in `Read(.env*)`) or an outside path asks. A directory read recursively (`grep -r KEY .`)
 * or a glob (`cat .e*`) "covers its subtree": when any `Read` deny/ask rule could match something
 * in it the command asks. This holds in default, plan and acceptEdits mode; bypassPermissions skips
 * the containment and ask checks (deny rules still apply, and a deny rule that could match asks).
 *
 * File tools of kind `read` that list directories are approved on a directory and their output
 * is filtered by the plugin (`readBlocked`). In every mode, bypass included, a non-read-only shell
 * command whose text mentions a protected path asks, and an allow rule never approves a command
 * that redirects (or `tee`s) outside the working directories.
 */
import { type GuardTranscriptEntry, HarnessError } from '../index.ts'
import { parseCommand } from './command.ts'
import {
  escapeRegExp,
  ignoreMatcher,
  isAbsolute,
  isInside,
  join,
  normalize,
  relative,
  resolve,
} from './paths.ts'
import {
  type CommandFilter,
  type Cover,
  isGlobArg,
  isReadOnlyCommand,
  isReadOnlySubcommand,
  READ_ONLY_COMMAND_NAMES,
  readPathArguments,
} from './readonly.ts'
import {
  callTarget,
  type MatchContext,
  type ParsedRule,
  parseRule,
  pathMatchesSpecifier,
  ruleMatchesCall,
  specifierCouldMatch,
  toRealPath,
  urlHost,
} from './rules.ts'
import { commandOf, createToolTable, fieldOf, type ToolTable } from './tools.ts'
import {
  type AutoAction,
  type AutoClassifier,
  type AutoEvent,
  type AutoListener,
  type AutoState,
  DEFAULT_MODE_CYCLE,
  type ModeListener,
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

/** Reason of a `dontAsk` denial. */
export const DONT_ASK_REASON = 'Not allowed without approval in dontAsk mode.'
/** Reason of a plan-mode denial. */
export const PLAN_MODE_REASON = 'Plan mode: present the plan with exit_plan_mode first.'

/** Blocks in a row that pause auto mode. */
export const AUTO_MAX_CONSECUTIVE_BLOCKS = 3
/** Blocks in total that pause auto mode. */
export const AUTO_MAX_TOTAL_BLOCKS = 20
/** Reason of a call that asks because auto mode is paused. */
export const AUTO_PAUSED_REASON =
  'Auto mode is paused after repeated blocks: this action needs approval.'

/** Ask rules built in; an explicit allow rule overrides them. */
export const DEFAULT_BUILTIN_ASK: readonly string[] = ['Read(.env*)', 'Read(**/.env*)']
/** Paths (relative to a root) that always ask before a write, in every mode. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ['.git']

const NULL_DEVICE = '/dev/null'
const FILE_OPS = new Set(['mkdir', 'touch', 'mv', 'cp'])
const PLAN_KINDS: readonly ToolKind[] = ['read', 'search', 'fetch', 'agent', 'ask', 'safe']

/** Options of {@link createPermissionEngine}. */
export interface PermissionEngineOptions {
  /**
   * The directories of the virtual tree the file tools address (called on every decision, so
   * directories can be added at runtime). The root mounted at `/` is the project root that
   * relative rule paths and shell commands resolve against; without one, the first root is.
   */
  roots: () => readonly PermissionRoot[]
  /** Home directory for `~/` in rule specifiers and shell paths. Required by rules that use `~/`. */
  home?: string
  /** Initial mode. Default `default`. */
  mode?: PermissionMode
  /** Initial rules. */
  rules?: Partial<PermissionRules>
  /**
   * Gitignore patterns, relative to each root, that always ask before a write in every mode
   * (and before a shell command that mentions them). Default `['.git']`; `[]` disables.
   */
  protectedPaths?: readonly string[]
  /** Ask rules applied unless an allow rule names the path. Default `Read(.env*)`, `Read(**\/.env*)`. */
  builtinAsk?: readonly string[]
  /**
   * Shell commands that auto-approve when their arguments pass the grammar: `'default'` (every
   * built-in grammar), a list of command names (a subset of them) or `[]` (none).
   */
  readOnlyCommands?: 'default' | readonly string[]
  /** What each tool is; merged over `DEFAULT_TOOL_KINDS`. */
  toolKinds?: ToolKinds
  /** Rule aliases (`Read`, `Edit`, …); merged over `DEFAULT_ALIASES`. */
  aliases?: Record<string, readonly string[]>
  /** Order of `cycleMode()`. Default `default`, `acceptEdits`, `plan` (see `modeCycleFor`). */
  modeCycle?: readonly PermissionMode[]
  /**
   * Judges the actions `auto` mode cannot settle by rules or read-only checks (spec 18 §12).
   * Without it `auto` is unavailable: `setMode('auto')` and `mode: 'auto'` throw
   * `EH_CONFIG_INVALID`, and `auto` is dropped from the cycle.
   */
  classifier?: AutoClassifier
  /**
   * Called with a copy of the stored rules and the change after `allow`, `addRule` and
   * `removeRule` changed them, so an application can store them (a database row, a settings
   * file). Rules added with scope `'session'` are not in the copy and do not call `persist`.
   * Rules are in memory otherwise.
   */
  persist?: (rules: PermissionRules, change: RuleChange) => void | Promise<void>
}

/** The permission engine. */
/** Options of {@link PermissionEngine.decideAsync}. */
export interface DecideOptions {
  /** Mode of this call instead of the engine's (as `decide`'s second argument). */
  mode?: PermissionMode
  /**
   * The id of the tool call. The core re-validates approved calls, so the classifier verdict is
   * remembered per id: asked once, counted once.
   */
  toolCallId?: string
  /** The restricted transcript for the classifier (`tool.approve` event `transcript()`). */
  transcript?: () => readonly GuardTranscriptEntry[]
  abortSignal?: AbortSignal
}

export interface PermissionEngine {
  readonly mode: PermissionMode
  /** `setMode('auto')` throws `EH_CONFIG_INVALID` when the engine has no `classifier`. */
  setMode(mode: PermissionMode): void
  /** Next mode of the cycle (from any mode outside the cycle: the first one). */
  cycleMode(): PermissionMode
  /** True when the engine has a classifier, i.e. `auto` mode can be used. */
  readonly autoAvailable: boolean
  /**
   * Deterministic and free of side effects (it runs inside `tool.approve`). In `auto` mode a call
   * the rules and read-only checks cannot settle comes back as `user-approval` with
   * `auto: 'classify'`; `decideAsync` runs the classifier.
   */
  decide(call: PermissionCall, mode?: PermissionMode): PermissionDecision
  /**
   * `decide`, plus the `auto` classifier: a `classify` result becomes approved (`auto: 'allowed'`),
   * denied with a reason the model reads (`auto: 'blocked'`, a classifier error included), or, while
   * auto mode is paused, a person's ask (`auto: 'paused'`). Updates the block counters.
   */
  decideAsync(call: PermissionCall, options?: DecideOptions): Promise<PermissionDecision>
  /** Block counters and whether auto mode is paused. */
  autoState(): AutoState
  /** A person approved an action: resumes a paused auto mode (consecutive blocks restart at 0). */
  noteApproval(): void
  /** Resume a paused auto mode explicitly. */
  resumeAuto(): void
  /** Listen to auto mode events (blocks, pause, resume); returns the unsubscribe function. */
  subscribeAuto(listener: AutoListener): () => void
  /** Rule to offer for "don't ask again" (`Bash(git status *)`, `Edit`, …), if any. */
  suggestRule(call: PermissionCall): string | undefined
  /** Add an allow rule (scope `project` by default). Resolves when `persist` finished. */
  allow(rule: string, scope?: RuleScope): Promise<void>
  /**
   * Add a rule of any kind. `session` rules live in memory only (not stored, `persist` is not
   * called); `project` (default) rules call `persist`. Throws `EH_CONFIG_INVALID` for an invalid
   * rule. Resolves when `persist` finished.
   */
  addRule(kind: keyof PermissionRules, rule: string, scope?: RuleScope): Promise<void>
  /** Remove a rule; resolves with whether it existed. Removing a session rule does not call `persist`. */
  removeRule(kind: keyof PermissionRules, rule: string): Promise<boolean>
  /** A copy of the rules. */
  rules(): PermissionRules
  /**
   * Tools a mode makes unavailable (plan mode: everything that writes or is unknown; every other
   * mode: the plan-exit tool) plus the tools a deny rule without specifier removes. Pass the
   * tool names of the request to also cover tools the tool map does not know.
   */
  inactiveTools(mode?: PermissionMode, toolNames?: readonly string[]): string[]
  /** Listen to mode changes; returns the unsubscribe function. */
  subscribe(listener: ModeListener): () => void
  /** The kind of a tool (`other` when unknown). */
  kindOf(toolName: string): ToolKind
  /** Names of the tools of a kind in the tool map. */
  toolsOfKind(kind: ToolKind): string[]
  /** The tool map entry of a tool, if it has one. */
  toolSpec(toolName: string): ToolKindSpec | undefined
  /** Tool names a rule's tool part (alias or name) stands for. */
  expandRuleTool(ruleTool: string): readonly string[]
  /**
   * True when a `Read` deny or ask rule (the built-in `.env*` ask included, unless an allow rule
   * names the path) matches a virtual path: the plugin hides such paths from listing outputs.
   */
  readBlocked(virtualPath: string): boolean
  /** The mode that was active before plan mode was entered (`default` when unknown). */
  modeBeforePlan(): PermissionMode
  /**
   * Remember the mode the user chose when approving the plan (`acceptEdits` or `default`):
   * leaving plan mode switches to it. Cleared when plan mode is entered again.
   */
  setPlanExitMode(mode: PermissionMode | undefined): void
  /** The mode chosen for leaving plan mode, if any (not consumed). */
  planExitMode(): PermissionMode | undefined
  /** Mode the plan-exit tool switches to: the chosen one, else the one before plan mode. Consumes the choice. */
  leavePlanMode(): PermissionMode
}

/** Everything one decision needs. */
interface Env extends MatchContext {
  ro: CommandFilter
  isProtected(real: string): boolean
  protectedText: RegExp | undefined
  workingDirs: string[]
  writableDirs: string[]
  builtinAsk: ParsedRule[]
}

const invalid = (message: string): HarnessError =>
  new HarnessError('EH_CONFIG_INVALID', `permissions: ${message}`)
const noClassifier = (): HarnessError => invalid("auto mode needs the engine's `classifier` option")

/** Resolve a path written in a shell command (relative to the project root). */
function shellPath(arg: string, env: Env): string {
  if (arg === '~' || arg.startsWith('~/')) {
    return env.home === undefined ? '/\0no-home' : join(env.home, arg.slice(1))
  }
  return isAbsolute(arg) ? normalize(arg) : resolve(env.root, arg)
}

/** What the read-only parts of a bash command read. */
interface ReadAccess {
  check: string[]
  match: string[]
  /** Directories read recursively and globs: everything they stand for is read. */
  cover: Cover[]
  unsafe: boolean
}

/** True when the path argument of a shell command cannot be resolved lexically. */
function unresolvable(arg: string): boolean {
  return /[$`{]/.test(arg) || (arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/'))
}

/** Path arguments of the read-only parts of a bash command (subcommands and `<` redirects). */
function bashReadAccess(command: string, env: Env): ReadAccess {
  const parsed = parseCommand(command)
  const access: ReadAccess = {
    check: [...parsed.inputs],
    match: [...parsed.inputs],
    cover: parsed.inputs.filter(isGlobArg).map((arg) => ({ arg, subtree: false })),
    unsafe: false,
  }
  const readOnly = (sub: string): boolean => isReadOnlySubcommand(sub, env.ro)
  for (const sub of parsed.subcommands) {
    if (!readOnly(sub)) continue
    const paths = readPathArguments(sub, env.ro)
    access.check.push(...paths.check)
    access.match.push(...paths.match)
    access.cover.push(...paths.cover)
    if (paths.unsafe) access.unsafe = true
  }
  if (parsed.xargs && parsed.subcommands.some(readOnly)) access.unsafe = true
  if (parsed.inputs.some(unresolvable)) access.unsafe = true
  return access
}

/**
 * Why a command's read-only parts cannot be auto-approved (a path outside the working
 * directories or one that cannot be resolved), or `undefined` when they can.
 */
function readPathProblem(command: string, env: Env): string | undefined {
  const access = bashReadAccess(command, env)
  if (access.unsafe) return 'reads a path that cannot be resolved statically ($VAR, ~user, {…})'
  for (const arg of access.check) {
    const real = shellPath(arg, env)
    if (!env.workingDirs.some((dir) => isInside(real, dir))) {
      return 'reads outside the working directories'
    }
  }
  return undefined
}

/** `Read` rules of a list (tool part covers a tool of kind `read`). */
const readRulesOf = (rules: readonly ParsedRule[], env: Env): ParsedRule[] =>
  rules.filter((rule) => env.tools.coversKind(rule.tool, 'read'))

/** The first `Read` rule that matches a path read by a bash command exactly. */
function readRuleForCommand(
  rules: readonly ParsedRule[],
  command: string,
  env: Env,
): ParsedRule | undefined {
  const reals = bashReadAccess(command, env).match.map((arg) => shellPath(arg, env))
  if (reals.length === 0) return undefined
  return readRulesOf(rules, env).find(
    (rule) =>
      rule.specifier === undefined ||
      reals.some((real) => pathMatchesSpecifier(rule.specifier as string, real, env)),
  )
}

/**
 * The first `Read` rule that could match a file under a directory a bash command reads
 * recursively, or one that a glob argument could expand to.
 */
function readRuleCovering(
  rules: readonly ParsedRule[],
  command: string,
  env: Env,
): ParsedRule | undefined {
  const cover = bashReadAccess(command, env).cover
  if (cover.length === 0) return undefined
  return readRulesOf(rules, env).find(
    (rule) =>
      rule.specifier !== undefined &&
      cover.some((c) =>
        specifierCouldMatch(rule.specifier as string, shellPath(c.arg, env), c.subtree, env),
      ),
  )
}

const COVER_REASON = (rule: ParsedRule): string => `may read files matched by ${rule.raw}`

/** Real paths a call would write: the target of a write tool, or the redirect targets of a shell command. */
function writeTargets(call: PermissionCall, env: Env): string[] {
  switch (env.tools.kindOf(call.toolName)) {
    case 'write': {
      const target = callTarget(call, env)
      return target === undefined || target === null ? [] : [target.real]
    }
    case 'shell': {
      const command = commandOf(call, env.tools.spec(call.toolName))
      if (command === undefined) return []
      return parseCommand(command)
        .redirects.filter((t) => t !== NULL_DEVICE)
        .map((t) => shellPath(t, env))
    }
    default:
      return []
  }
}

/** Does a rule deny/ask this write path (an `Edit` rule applied to a redirect target)? */
function editRuleMatchesPath(rule: ParsedRule, real: string, env: Env): boolean {
  if (!env.tools.coversKind(rule.tool, 'write')) return false
  return rule.specifier === undefined || pathMatchesSpecifier(rule.specifier, real, env)
}

/** acceptEdits: only reads and `mkdir`/`touch`/`mv`/`cp` whose paths are inside writable dirs. */
function isAcceptedFileCommand(command: string, env: Env): boolean {
  const parsed = parseCommand(command)
  if (parsed.complex || parsed.subcommands.length === 0) return false
  if (parsed.redirects.some((t) => t !== NULL_DEVICE)) return false
  if (readPathProblem(command, env) !== undefined) return false
  for (const sub of parsed.subcommands) {
    if (isReadOnlySubcommand(sub, env.ro)) continue
    const [name, ...args] = sub.split(' ')
    if (name === undefined || !FILE_OPS.has(name)) return false
    const flags = args.filter((a) => a.startsWith('-'))
    if (flags.some((f) => f === '-t' || f.startsWith('--target') || f === '--')) return false
    const paths = args.filter((a) => !a.startsWith('-'))
    if (paths.length === 0) return false
    for (const arg of paths) {
      if (/[$`]/.test(arg)) return false
      const real = shellPath(arg, env)
      if (!env.writableDirs.some((dir) => isInside(real, dir))) return false
      if (env.isProtected(real)) return false
    }
  }
  return true
}

/** Programs that run other programs or code: never offer a prefix rule for them. */
const WRAPPERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'node',
  'nodejs',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'eval',
  'exec',
  'ssh',
  'find',
  'awk',
  'gawk',
  'sed',
  'npx',
  'bunx',
  'pnpx',
  'uvx',
  'pipx',
  'nohup',
  'time',
  'nice',
  'timeout',
  'command',
  'builtin',
  'watch',
  'osascript',
])

/**
 * Rule offered for "don't ask again": `Bash(prog sub *)` for an ordinary program, the exact
 * command for an interpreter, shell or wrapper (`bash -c`, `python3 -c`, `env`, `sudo`, `xargs`,
 * …), when the second word is a flag, for `git config`, and for a one-word command. Compound and
 * complex commands, and commands containing `*`, get no rule.
 */
function bashSuggestion(command: string): string | undefined {
  const parsed = parseCommand(command)
  if (parsed.complex || parsed.subcommands.length !== 1) return undefined
  const first = parsed.subcommands[0] as string
  if (first.includes('*')) return undefined
  const words = first.split(' ')
  const program = (words[0] as string).split('/').pop() as string
  const second = words[1]
  if (second === undefined) return `Bash(${first})`
  const risky =
    WRAPPERS.has(program) ||
    /^python[\d.]*$/.test(program) ||
    second.startsWith('-') ||
    (program === 'git' && second === 'config')
  return risky ? `Bash(${first})` : `Bash(${words[0]} ${second} *)`
}

/**
 * Allow rules auto mode ignores: they would approve arbitrary code without the classifier looking
 * (a bare `Bash`, `Bash(*)`, `Bash(python*)`, `Bash(bash:*)`, a wildcarded wrapper or interpreter).
 * Narrow rules such as `Bash(bun test *)` stay in effect.
 */
function broadAutoAllow(rule: ParsedRule, env: Env): boolean {
  if (!env.tools.coversKind(rule.tool, 'shell')) return false
  const spec = rule.specifier?.trim()
  if (spec === undefined || /^\*+$/.test(spec)) return true
  const words = spec.split(/\s+/)
  const first = (words[0] ?? '').replace(/:\*$/, '')
  if (first.includes('*')) return true // `python*`, `*` as the program
  const program = first.split('/').pop() ?? ''
  const risky = WRAPPERS.has(program) || /^python[\d.]*$/.test(program)
  const wildcardRest = words.length === 1 ? (words[0] ?? '').endsWith(':*') : words[1] === '*'
  return risky && wildcardRest && words.length <= 2
}

/** Literal first path segments of the protected patterns (`.git`, `.app`): what a command text is searched for. */
function protectedTextPattern(patterns: readonly string[]): RegExp | undefined {
  const names = new Set<string>()
  for (const pattern of patterns) {
    const first = pattern.replace(/^(\.?\/)+/, '').split('/')[0] ?? ''
    if (first !== '' && !/[*?[\\!#]/.test(first)) names.add(first)
  }
  if (names.size === 0) return undefined
  return new RegExp(`(?<![\\w.-])(?:${[...names].map(escapeRegExp).join('|')})(?![\\w.-])`)
}

/** Parse a rule list, throwing `EH_CONFIG_INVALID` for an invalid rule or an unusable `~/`. */
function parseRules(list: readonly string[], home: string | undefined): ParsedRule[] {
  return list.map((raw) => checkedRule(raw, home))
}

function checkedRule(raw: string, home: string | undefined): ParsedRule {
  const rule = parseRule(raw)
  if (rule === undefined) throw invalid(`invalid permission rule: ${raw}`)
  if (rule.specifier?.startsWith('~/') === true && home === undefined) {
    throw invalid(`rule ${rule.raw} uses ~/ but the engine has no \`home\` option`)
  }
  return rule
}

/**
 * Create the permission engine (spec 18).
 *
 * @throws HarnessError `EH_CONFIG_INVALID` for an invalid initial rule or mode.
 */
export function createPermissionEngine(options: PermissionEngineOptions): PermissionEngine {
  const home = options.home
  const tools: ToolTable = createToolTable(options.toolKinds, options.aliases)
  const classifier = options.classifier
  if (options.mode === 'auto' && classifier === undefined) throw noClassifier()
  let mode: PermissionMode = options.mode ?? 'default'
  let beforePlan: PermissionMode = 'default'
  let planExit: PermissionMode | undefined
  const cycle = (options.modeCycle ?? DEFAULT_MODE_CYCLE).filter(
    (m) => m !== 'auto' || classifier !== undefined,
  )
  const rules: PermissionRules = {
    allow: [...(options.rules?.allow ?? [])],
    ask: [...(options.rules?.ask ?? [])],
    deny: [...(options.rules?.deny ?? [])],
  }
  const listeners = new Set<ModeListener>()
  const parsedCache = new Map<string, ParsedRule>()
  const parsed = (list: readonly string[]): ParsedRule[] =>
    list.map((raw) => {
      let rule = parsedCache.get(raw)
      if (rule === undefined) {
        rule = checkedRule(raw, home)
        parsedCache.set(raw, rule)
      }
      return rule
    })
  for (const kind of ['allow', 'ask', 'deny'] as const) parseRules(rules[kind], home)

  const protectedPatterns = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS
  const protectedMatch = ignoreMatcher(protectedPatterns)
  const protectedText = protectedTextPattern(protectedPatterns)
  const builtinAsk = parseRules(options.builtinAsk ?? DEFAULT_BUILTIN_ASK, home)
  const ro: CommandFilter =
    options.readOnlyCommands === undefined || options.readOnlyCommands === 'default'
      ? undefined
      : new Set(options.readOnlyCommands.filter((n) => READ_ONLY_COMMAND_NAMES.includes(n)))

  const env = (): Env => {
    const roots = options.roots()
    const projectRoot = roots.find((r) => normalize(`/${r.virtual}`) === '/') ?? roots[0]
    const root = projectRoot === undefined ? '/' : normalize(projectRoot.real)
    const isProtected = (real: string): boolean => {
      for (const r of roots) {
        const dir = normalize(r.real)
        if (!isInside(real, dir)) continue
        const rel = relative(dir, real)
        if (rel !== '' && protectedMatch(rel)) return true
      }
      return false
    }
    const out: Env = {
      root,
      roots,
      tools,
      ro,
      isProtected,
      protectedText,
      builtinAsk,
      workingDirs: [
        root,
        ...roots.filter((r) => r.workingDir !== false).map((r) => normalize(r.real)),
      ],
      writableDirs: roots.filter((r) => r.readonly !== true).map((r) => normalize(r.real)),
    }
    if (home !== undefined) out.home = normalize(home)
    return out
  }

  const outside = (target: null | undefined): PermissionDecision =>
    target === undefined
      ? { status: 'denied', reason: 'Invalid path.' }
      : { status: 'denied', reason: 'The path is outside the working directories.' }

  /** What `auto` mode sends to the classifier (see `decideAsync`). */
  const classify: PermissionDecision = {
    status: 'user-approval',
    reason: 'Auto mode: the classifier decides.',
    auto: 'classify',
  }

  const modeDefault = (
    call: PermissionCall,
    kind: ToolKind,
    m: PermissionMode,
    e: Env,
  ): PermissionDecision => {
    switch (kind) {
      case 'read': {
        const target = callTarget(call, e)
        if (target === undefined || target === null) return outside(target)
        return { status: 'approved' }
      }
      case 'write': {
        const target = callTarget(call, e)
        if (target === undefined || target === null) return outside(target)
        if (target.root.readonly === true) {
          return { status: 'denied', reason: 'That directory is read-only.' }
        }
        return m === 'acceptEdits' || m === 'bypassPermissions' || m === 'auto'
          ? { status: 'approved' }
          : { status: 'user-approval' }
      }
      case 'shell': {
        const command = commandOf(call, tools.spec(call.toolName))
        if (command === undefined) return { status: 'user-approval' }
        if (isReadOnlyCommand(command, e.ro)) {
          const problem = m === 'bypassPermissions' ? undefined : readPathProblem(command, e)
          if (problem === undefined) return { status: 'approved' }
          return m === 'auto' ? classify : { status: 'user-approval', reason: problem }
        }
        if (m === 'bypassPermissions') return { status: 'approved' }
        if ((m === 'acceptEdits' || m === 'auto') && isAcceptedFileCommand(command, e)) {
          return { status: 'approved' }
        }
        return m === 'auto' ? classify : { status: 'user-approval' }
      }
      case 'agent':
      case 'ask':
      case 'safe':
        return { status: 'approved' }
      default:
        if (m === 'bypassPermissions') return { status: 'approved' }
        return m === 'auto' ? classify : { status: 'user-approval' }
    }
  }

  /** Why an allow rule must not approve this shell command: its write targets, or `undefined`. */
  const allowBlocker = (call: PermissionCall, targets: string[], e: Env): string | undefined => {
    if (tools.kindOf(call.toolName) !== 'shell') return undefined
    const command = commandOf(call, tools.spec(call.toolName))
    if (command === undefined) return undefined
    const raw = parseCommand(command).redirects.filter((t) => t !== NULL_DEVICE)
    if (raw.some(unresolvable)) return 'writes to a path that cannot be resolved statically'
    for (const real of targets) {
      if (!e.writableDirs.some((dir) => isInside(real, dir))) {
        return 'writes outside the working directories'
      }
    }
    return undefined
  }

  const evaluate = (call: PermissionCall, m: PermissionMode): PermissionDecision => {
    const e = env()
    const name = call.toolName
    const kind = tools.kindOf(name)
    const targets = writeTargets(call, e)
    const bash = kind === 'shell' ? commandOf(call, tools.spec(name)) : undefined
    const readRule = (list: ParsedRule[]): ParsedRule | undefined =>
      bash === undefined ? undefined : readRuleForCommand(list, bash, e)
    const coverRule = (list: ParsedRule[]): ParsedRule | undefined =>
      bash === undefined ? undefined : readRuleCovering(list, bash, e)
    const editRules = (list: ParsedRule[]): ParsedRule | undefined =>
      list.find((rule) => targets.some((real) => editRuleMatchesPath(rule, real, e)))
    const readOnly = bash !== undefined && isReadOnlyCommand(bash, e.ro)

    // 1. deny rules
    const denies = parsed(rules.deny)
    const denied =
      denies.find((rule) => ruleMatchesCall(rule, call, 'restrict', e)) ??
      (bash !== undefined ? (editRules(denies) ?? readRule(denies)) : undefined)
    if (denied !== undefined) {
      return { status: 'denied', rule: denied.raw, reason: `Denied by the rule ${denied.raw}.` }
    }

    // the question tool is not an action: it only talks to the user (ask rules cannot gate it)
    if (kind === 'ask') return { status: 'approved' }

    // 2. the plan-exit tool
    if (kind === 'plan-exit') {
      if (m !== 'plan') {
        return { status: 'denied', reason: 'exit_plan_mode is only available in plan mode.' }
      }
      return { status: 'user-approval', reason: 'The user must approve the plan.' }
    }

    // 3. plan mode: reads and read-only commands only
    if (m === 'plan' && !PLAN_KINDS.includes(kind) && !(kind === 'shell' && readOnly)) {
      return { status: 'denied', reason: PLAN_MODE_REASON }
    }

    // 3b. tools that always involve a human (`alwaysAsk`): in every mode, despite allow rules
    if (tools.spec(name)?.alwaysAsk === true) {
      return { status: 'user-approval', reason: 'This tool always asks for approval.' }
    }

    // 4. protected paths ask in every mode (bypassPermissions included)
    if (targets.some((real) => e.isProtected(real))) {
      return {
        status: 'user-approval',
        reason: `Protected path (${protectedPatterns.join(', ')}): always asks.`,
      }
    }
    if (bash !== undefined && !readOnly && e.protectedText !== undefined) {
      const parsedCommand = parseCommand(bash)
      if (e.protectedText.test(`${bash}\n${parsedCommand.subcommands.join('\n')}`)) {
        return { status: 'user-approval', reason: 'touches a protected path' }
      }
    }

    // 4b. a directory or glob read by a command that a deny rule could match: always asks
    const coveredDeny = coverRule(denies)
    if (coveredDeny !== undefined) {
      return { status: 'user-approval', rule: coveredDeny.raw, reason: COVER_REASON(coveredDeny) }
    }

    // 5. ask rules
    if (m !== 'bypassPermissions') {
      const asks = parsed(rules.ask)
      const ask =
        asks.find((rule) => ruleMatchesCall(rule, call, 'restrict', e)) ??
        (bash !== undefined ? (editRules(asks) ?? readRule(asks)) : undefined)
      if (ask !== undefined) {
        return { status: 'user-approval', rule: ask.raw, reason: `Asks by the rule ${ask.raw}.` }
      }
      const coveredAsk = coverRule(asks)
      if (coveredAsk !== undefined) {
        return { status: 'user-approval', rule: coveredAsk.raw, reason: COVER_REASON(coveredAsk) }
      }
    }

    // 6. allow rules (never for a command that writes outside the working directories)
    const allow = parsed(rules.allow).find(
      (rule) =>
        !(m === 'auto' && broadAutoAllow(rule, e)) && ruleMatchesCall(rule, call, 'allow', e),
    )
    if (allow !== undefined) {
      const blocker = allowBlocker(call, targets, e)
      if (blocker !== undefined) {
        return { status: 'user-approval', rule: allow.raw, reason: blocker }
      }
      return { status: 'approved', rule: allow.raw }
    }

    // 7. built-in ask rules (an allow rule above overrides them)
    if (m !== 'bypassPermissions') {
      const soft =
        e.builtinAsk.find((rule) => ruleMatchesCall(rule, call, 'restrict', e)) ??
        readRule(e.builtinAsk)
      if (soft !== undefined) {
        return {
          status: 'user-approval',
          rule: soft.raw,
          reason: 'Environment files may hold secrets: asks first.',
        }
      }
      const coveredSoft = coverRule(e.builtinAsk)
      if (coveredSoft !== undefined) {
        return {
          status: 'user-approval',
          rule: coveredSoft.raw,
          reason: COVER_REASON(coveredSoft),
        }
      }
    }

    // 8. mode default
    return modeDefault(call, kind, m, e)
  }

  const inactive = (m: PermissionMode, names: readonly string[] | undefined): string[] => {
    const out = new Set<string>()
    for (const name of new Set([...tools.names(), ...(names ?? [])])) {
      const kind = tools.kindOf(name)
      if (m === 'plan') {
        if (kind === 'write' || kind === 'other') out.add(name)
      } else if (kind === 'plan-exit') {
        out.add(name)
      }
    }
    for (const rule of parsed(rules.deny)) {
      if (rule.specifier === undefined) for (const t of tools.expand(rule.tool)) out.add(t)
    }
    return [...out]
  }

  // auto mode state (spec 18 §12)
  const auto: AutoState = { paused: false, consecutive: 0, total: 0 }
  const autoListeners = new Set<AutoListener>()
  const autoSnapshot = (): AutoState => ({ ...auto })
  const emitAuto = (event: AutoEvent): void => {
    for (const listener of [...autoListeners]) listener(event)
  }
  const resume = (): void => {
    if (!auto.paused) return
    auto.paused = false
    auto.consecutive = 0
    emitAuto({ type: 'resumed', state: autoSnapshot() })
  }
  const recordBlock = (toolName: string, why: string): void => {
    auto.consecutive++
    auto.total++
    emitAuto({ type: 'blocked', toolName, reason: why, state: autoSnapshot() })
    const cause =
      auto.consecutive >= AUTO_MAX_CONSECUTIVE_BLOCKS
        ? 'consecutive'
        : auto.total >= AUTO_MAX_TOTAL_BLOCKS
          ? 'total'
          : undefined
    if (cause === undefined) return
    auto.paused = true
    if (cause === 'total') auto.total = 0
    emitAuto({ type: 'paused', cause, state: autoSnapshot() })
  }
  // verdicts per tool call id: the core re-validates approved calls, the classifier runs once
  const verdicts = new Map<string, Promise<PermissionDecision>>()

  const classifyCall = async (
    call: PermissionCall,
    opts: DecideOptions,
  ): Promise<PermissionDecision> => {
    const kind = tools.kindOf(call.toolName)
    const spec = tools.spec(call.toolName)
    const action: AutoAction = { toolName: call.toolName, input: call.input, kind }
    const summary =
      kind === 'shell'
        ? commandOf(call, spec)
        : kind === 'fetch'
          ? fieldOf(call.input, spec?.urlField ?? 'url')
          : undefined
    if (summary !== undefined) action.summary = summary
    if (call.agent !== undefined) action.agent = call.agent
    let transcript: readonly GuardTranscriptEntry[] = []
    try {
      transcript = opts.transcript?.() ?? []
    } catch {
      transcript = []
    }
    const ctx: { transcript: readonly GuardTranscriptEntry[]; abortSignal?: AbortSignal } = {
      transcript,
    }
    if (opts.abortSignal !== undefined) ctx.abortSignal = opts.abortSignal
    let why: string
    let reason: string
    try {
      const verdict = await (classifier as AutoClassifier)(action, ctx)
      if (verdict?.decision === 'allow') {
        auto.consecutive = 0
        return { status: 'approved', auto: 'allowed' }
      }
      if (verdict?.decision === 'block') {
        why = typeof verdict.reason === 'string' ? verdict.reason.trim() : ''
        if (why === '') why = 'the classifier judged it unsafe'
        reason = `Auto mode blocked this action: ${why}. Do not retry it as is; choose a safer approach or ask the user.`
      } else {
        why = 'unreadable classifier verdict'
        reason = 'Auto mode could not classify this action (unreadable verdict), so it was blocked.'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      why = `classifier unavailable (${message})`
      reason = `Auto mode could not classify this action (${message}), so it was blocked.`
    }
    recordBlock(call.toolName, why)
    return { status: 'denied', reason, auto: 'blocked' }
  }

  const decide = (call: PermissionCall, modeOverride?: PermissionMode): PermissionDecision => {
    const m = modeOverride ?? mode
    const decision = evaluate(call, m)
    // the global dontAsk also turns the asks of a per-agent mode override into denials
    if ((m === 'dontAsk' || mode === 'dontAsk') && decision.status === 'user-approval') {
      const out: PermissionDecision = { status: 'denied', reason: DONT_ASK_REASON }
      if (decision.rule !== undefined) out.rule = decision.rule
      return out
    }
    return decision
  }

  const setMode = (next: PermissionMode): void => {
    if (next === mode) return
    if (next === 'auto') {
      if (classifier === undefined) throw noClassifier()
      resume()
    }
    if (next === 'plan') {
      beforePlan = mode
      planExit = undefined
    }
    mode = next
    for (const listener of [...listeners]) listener(mode)
  }

  // rules added with scope 'session' (`kind\0rule`): decided on, never stored
  const sessionRules = new Set<string>()
  const sessionKey = (kind: keyof PermissionRules, rule: string): string => `${kind}\0${rule}`
  const stored = (): PermissionRules => {
    const keep = (kind: keyof PermissionRules): string[] =>
      rules[kind].filter((rule) => !sessionRules.has(sessionKey(kind, rule)))
    return { allow: keep('allow'), ask: keep('ask'), deny: keep('deny') }
  }
  const persist = async (change: RuleChange): Promise<void> => {
    await options.persist?.(stored(), change)
  }

  const addRule = async (
    kind: keyof PermissionRules,
    rule: string,
    scope: RuleScope = 'project',
  ): Promise<void> => {
    const clean = rule.trim()
    checkedRule(clean, home)
    const key = sessionKey(kind, clean)
    if (!rules[kind].includes(clean)) {
      rules[kind].push(clean)
      if (scope === 'session') sessionRules.add(key)
    } else if (scope === 'project') {
      sessionRules.delete(key) // a session rule promoted to the project
    }
    if (scope === 'session') return
    await persist({ op: 'add', kind, rule: clean, scope })
  }

  return {
    get mode(): PermissionMode {
      return mode
    },
    setMode,
    modeBeforePlan(): PermissionMode {
      return beforePlan === 'plan' ? 'default' : beforePlan
    },
    setPlanExitMode(next: PermissionMode | undefined): void {
      planExit = next === 'acceptEdits' || next === 'default' ? next : undefined
    },
    planExitMode(): PermissionMode | undefined {
      return planExit
    },
    leavePlanMode(): PermissionMode {
      const target = planExit ?? (beforePlan === 'plan' ? 'default' : beforePlan)
      planExit = undefined
      return target
    },
    autoAvailable: classifier !== undefined,
    autoState: autoSnapshot,
    noteApproval: resume,
    resumeAuto: resume,
    subscribeAuto(listener: AutoListener): () => void {
      autoListeners.add(listener)
      return () => {
        autoListeners.delete(listener)
      }
    },
    async decideAsync(call: PermissionCall, opts: DecideOptions = {}): Promise<PermissionDecision> {
      const m = opts.mode ?? mode
      const decision = decide(call, opts.mode)
      if (decision.auto !== 'classify') return decision
      if (classifier === undefined) {
        return { status: 'user-approval', reason: 'Auto mode has no classifier configured.' }
      }
      if (auto.paused) {
        return { status: 'user-approval', reason: AUTO_PAUSED_REASON, auto: 'paused' }
      }
      const id = opts.toolCallId
      const known = id === undefined ? undefined : verdicts.get(id)
      const run = known ?? classifyCall(call, opts)
      if (id !== undefined && known === undefined) {
        verdicts.set(id, run)
        if (verdicts.size > 500) verdicts.delete(verdicts.keys().next().value as string)
      }
      const result = await run
      // the mode changed while the classifier ran: a verdict the new mode would not have asked for is dropped
      if (opts.mode === undefined && m === 'auto' && mode !== 'auto') return decide(call)
      return result
    },
    cycleMode(): PermissionMode {
      const index = cycle.indexOf(mode)
      const next = (index < 0 ? cycle[0] : cycle[(index + 1) % cycle.length]) ?? 'default'
      setMode(next)
      return next
    },
    decide,
    suggestRule(call: PermissionCall): string | undefined {
      const kind = tools.kindOf(call.toolName)
      if (kind === 'plan-exit' || kind === 'ask') return undefined
      if (tools.spec(call.toolName)?.alwaysAsk === true) return undefined
      const e = env()
      if (writeTargets(call, e).some((real) => e.isProtected(real))) return undefined
      switch (kind) {
        case 'shell': {
          const command = commandOf(call, tools.spec(call.toolName))
          if (command === undefined) return undefined
          if (e.protectedText?.test(command) === true) return undefined
          return bashSuggestion(command)
        }
        case 'write':
          return 'Edit'
        case 'fetch': {
          const host = urlHost(fieldOf(call.input, tools.spec(call.toolName)?.urlField ?? 'url'))
          return host === undefined ? undefined : `WebFetch(domain:${host})`
        }
        case 'search':
          return 'WebSearch'
        default:
          return call.toolName
      }
    },
    allow(rule: string, scope?: RuleScope): Promise<void> {
      return addRule('allow', rule, scope)
    },
    addRule,
    async removeRule(kind: keyof PermissionRules, rule: string): Promise<boolean> {
      const clean = rule.trim()
      const index = rules[kind].indexOf(clean)
      if (index === -1) return false
      rules[kind].splice(index, 1)
      if (sessionRules.delete(sessionKey(kind, clean))) return true
      await persist({ op: 'remove', kind, rule: clean, scope: 'project' })
      return true
    },
    rules(): PermissionRules {
      return { allow: [...rules.allow], ask: [...rules.ask], deny: [...rules.deny] }
    },
    inactiveTools(modeOverride?: PermissionMode, toolNames?: readonly string[]): string[] {
      return inactive(modeOverride ?? mode, toolNames)
    },
    subscribe(listener: ModeListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    kindOf: (name) => tools.kindOf(name),
    toolsOfKind: (kind) => tools.namesOfKind(kind),
    toolSpec: (name) => tools.spec(name),
    expandRuleTool: (ruleTool) => tools.expand(ruleTool),
    readBlocked(virtualPath: string): boolean {
      const e = env()
      const target = toRealPath(virtualPath, e.roots)
      if (target === undefined) return false
      const matches = (rule: ParsedRule): boolean =>
        rule.specifier !== undefined && pathMatchesSpecifier(rule.specifier, target.real, e)
      const reads = (list: readonly string[]): ParsedRule[] => readRulesOf(parsed(list), e)
      if (reads(rules.deny).some(matches) || reads(rules.ask).some(matches)) return true
      return readRulesOf(e.builtinAsk, e).some(matches) && !reads(rules.allow).some(matches)
    },
  }
}
