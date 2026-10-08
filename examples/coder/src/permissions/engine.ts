/**
 * The permission engine: decides every tool call from rules and the mode
 * (docs/plans/P30-coder-example.md §6.2, §6.3).
 *
 * Evaluation order: deny rules, plan-mode gate, protected paths, ask rules, allow rules, built-in
 * ask rules (`.env*` reads, overridable by an allow rule), then the mode default.
 *
 * Read-only shell commands (see `readonly-commands.ts`: per-command argument grammars) are not
 * approved blindly: their path arguments (and `<` redirects) are resolved lexically against the
 * project root. They auto-approve only when every path is inside a working directory (project
 * root or an `/@dirs/*` mount, not the tool-outputs mount), none uses an unresolvable expansion
 * (`$VAR` anywhere, `~user`, brace expansion, `xargs` stdin) and none matches a `Read` rule. A
 * `Read` deny match denies the command, a `Read` ask match (including the built-in
 * `Read(.env*)`) or an outside path asks. A directory read recursively (`grep -r KEY .`) or a glob
 * (`cat .e*`) "covers its subtree": when any `Read` deny/ask rule could match something in it the
 * command asks. This holds in default, plan and acceptEdits mode; bypassPermissions skips the
 * containment and ask checks (deny rules still apply, and a deny rule that could match asks).
 *
 * File tools (`grep`, `list_files`, `glob`) are approved on a directory and their output is
 * filtered by the plugin (`readBlocked`). In every mode, bypass included, a non-read-only bash
 * command whose text mentions a protected path asks, and an allow rule never approves a command
 * that redirects (or `tee`s) outside the working directories.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ignore from 'ignore'
import {
  type CoderConfig,
  MODE_CYCLE,
  type Mount,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionMode,
  type PermissionRules,
  READ_ONLY_TOOLS,
  TOOL,
  TOOL_ORDER,
  type ToolCallInfo,
} from '../contracts.ts'
import { parseCommand } from './bash-match.ts'
import {
  type Cover,
  isGlobArg,
  isReadOnlyCommand,
  isReadOnlySubcommand,
  readPathArguments,
} from './readonly-commands.ts'
import {
  callTarget,
  EDIT_PATH_TOOLS,
  type MatchContext,
  type ParsedRule,
  parseRule,
  pathMatchesSpecifier,
  READ_PATH_TOOLS,
  ruleMatchesCall,
  ruleToolMatches,
  specifierCouldMatch,
  toolsForRuleTool,
  toRealPath,
} from './rules.ts'

/** Reason of a `dontAsk` denial. */
export const DONT_ASK_REASON = 'Not allowed without approval in dontAsk mode.'
/** Reason of a plan-mode denial. */
export const PLAN_MODE_REASON = 'Plan mode: present the plan with exit_plan_mode first.'

/** Paths (relative to a mount root) that always ask before a write, in every mode. */
const PROTECTED = ['.git', '.coder/settings*.json', '.coder/agents']
/** Ask rules built in; an explicit allow rule overrides them. */
const BUILTIN_ASK = ['Read(.env*)', 'Read(**/.env*)']
const NULL_DEVICE = '/dev/null'
const FILE_OPS = new Set(['mkdir', 'touch', 'mv', 'cp'])

const protectedMatcher = ignore().add(PROTECTED)

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** True when the real path is a write-protected location inside one of the mounts. */
function isProtectedPath(real: string, mounts: readonly Mount[]): boolean {
  for (const mount of mounts) {
    if (!isInside(real, mount.real)) continue
    const rel = relative(mount.real, real)
    if (rel === '') continue
    try {
      if (protectedMatcher.ignores(rel.split('\\').join('/'))) return true
    } catch {
      // not a valid relative path: not protected
    }
  }
  return false
}

/** Resolve a path written in a shell command (relative to the project root). */
function shellPath(arg: string, ctx: MatchContext): string {
  if (arg === '~' || arg.startsWith('~/')) return join(ctx.home ?? homedir(), arg.slice(1))
  return isAbsolute(arg) ? resolve(arg) : resolve(ctx.root, arg)
}

const TOOL_OUTPUTS_VIRTUAL = '/.coder/tool-outputs/'

/** Real working directories: the project root and the mounts, except the tool-outputs mount. */
function workingDirs(ctx: MatchContext): string[] {
  const dirs = [ctx.root]
  for (const m of ctx.mounts) if (m.virtual !== TOOL_OUTPUTS_VIRTUAL) dirs.push(m.real)
  return dirs
}

/** What the read-only parts of a bash command read. */
interface ReadAccess {
  check: string[]
  match: string[]
  /** Directories read recursively and globs: everything they stand for is read. */
  cover: Cover[]
  unsafe: boolean
}

/** Path arguments of the read-only parts of a bash command (subcommands and `<` redirects). */
function bashReadAccess(command: string): ReadAccess {
  const parsed = parseCommand(command)
  const access: ReadAccess = {
    check: [...parsed.inputs],
    match: [...parsed.inputs],
    cover: parsed.inputs.filter(isGlobArg).map((arg) => ({ arg, subtree: false })),
    unsafe: false,
  }
  for (const sub of parsed.subcommands) {
    if (!isReadOnlySubcommand(sub)) continue
    const paths = readPathArguments(sub)
    access.check.push(...paths.check)
    access.match.push(...paths.match)
    access.cover.push(...paths.cover)
    if (paths.unsafe) access.unsafe = true
  }
  if (parsed.xargs && parsed.subcommands.some(isReadOnlySubcommand)) access.unsafe = true
  for (const input of parsed.inputs) {
    if (
      /[$`{]/.test(input) ||
      (input.startsWith('~') && input !== '~' && !input.startsWith('~/'))
    ) {
      access.unsafe = true
    }
  }
  return access
}

/**
 * Why a command's read-only parts cannot be auto-approved (a path outside the working
 * directories or one that cannot be resolved), or `undefined` when they can.
 */
function readPathProblem(command: string, ctx: MatchContext): string | undefined {
  const access = bashReadAccess(command)
  if (access.unsafe) return 'reads a path that cannot be resolved statically ($VAR, ~user, {…})'
  const dirs = workingDirs(ctx)
  for (const arg of access.check) {
    const real = shellPath(arg, ctx)
    if (!dirs.some((dir) => isInside(real, dir))) return 'reads outside the working directories'
  }
  return undefined
}

/** `Read` rules of a list (tool part `Read` or one of its tools). */
const readRulesOf = (rules: readonly ParsedRule[]): ParsedRule[] =>
  rules.filter((rule) => ruleToolMatches(rule.tool, TOOL.read))

/** The first `Read` rule that matches a path read by a bash command exactly. */
function readRuleForCommand(
  rules: readonly ParsedRule[],
  command: string,
  ctx: MatchContext,
): ParsedRule | undefined {
  const reals = bashReadAccess(command).match.map((arg) => shellPath(arg, ctx))
  if (reals.length === 0) return undefined
  return readRulesOf(rules).find(
    (rule) =>
      rule.specifier === undefined ||
      reals.some((real) => pathMatchesSpecifier(rule.specifier as string, real, ctx)),
  )
}

/**
 * The first `Read` rule that could match a file under a directory a bash command reads
 * recursively, or one that a glob argument could expand to.
 */
function readRuleCovering(
  rules: readonly ParsedRule[],
  command: string,
  ctx: MatchContext,
): ParsedRule | undefined {
  const cover = bashReadAccess(command).cover
  if (cover.length === 0) return undefined
  return readRulesOf(rules).find(
    (rule) =>
      rule.specifier !== undefined &&
      cover.some((c) =>
        specifierCouldMatch(rule.specifier as string, shellPath(c.arg, ctx), c.subtree, ctx),
      ),
  )
}

const COVER_REASON = (rule: ParsedRule): string => `may read files matched by ${rule.raw}`

/** Does the text of a command mention a write-protected location (`.git`, `.coder`)? */
const PROTECTED_TEXT = /(?<![\w.-])(?:\.git|\.coder)(?![\w.-])/

/** True when the path argument of a shell command cannot be resolved lexically. */
function unresolvable(arg: string): boolean {
  return /[$`{]/.test(arg) || (arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/'))
}

/** Real paths a call would write: the target of an edit tool, or the redirect targets of bash. */
function writeTargets(call: ToolCallInfo, ctx: MatchContext): string[] {
  if (EDIT_PATH_TOOLS.includes(call.toolName)) {
    const target = callTarget(call, ctx.mounts)
    return target === undefined || target === null ? [] : [target.real]
  }
  if (call.toolName === TOOL.bash) {
    const command = (call.input as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return []
    return parseCommand(command)
      .redirects.filter((t) => t !== NULL_DEVICE)
      .map((t) => shellPath(t, ctx))
  }
  return []
}

/** Does a rule deny/ask this write path (an `Edit` rule applied to a redirect target)? */
function editRuleMatchesPath(rule: ParsedRule, real: string, ctx: MatchContext): boolean {
  if (!ruleToolMatches(rule.tool, TOOL.edit)) return false
  return rule.specifier === undefined || pathMatchesSpecifier(rule.specifier, real, ctx)
}

/** acceptEdits: only reads and `mkdir`/`touch`/`mv`/`cp` whose paths are inside writable dirs. */
function isAcceptedFileCommand(command: string, ctx: MatchContext): boolean {
  const parsed = parseCommand(command)
  if (parsed.complex || parsed.subcommands.length === 0) return false
  if (parsed.redirects.some((t) => t !== NULL_DEVICE)) return false
  const writable = ctx.mounts.filter((m) => !m.readonly).map((m) => m.real)
  if (readPathProblem(command, ctx) !== undefined) return false
  for (const sub of parsed.subcommands) {
    if (isReadOnlySubcommand(sub)) continue
    const [name, ...args] = sub.split(' ')
    if (name === undefined || !FILE_OPS.has(name)) return false
    const flags = args.filter((a) => a.startsWith('-'))
    if (flags.some((f) => f === '-t' || f.startsWith('--target') || f === '--')) return false
    const paths = args.filter((a) => !a.startsWith('-'))
    if (paths.length === 0) return false
    for (const arg of paths) {
      if (/[$`]/.test(arg)) return false
      const real = shellPath(arg, ctx)
      if (!writable.some((dir) => isInside(real, dir))) return false
      if (isProtectedPath(real, ctx.mounts)) return false
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
 * …), when the second word is a flag, for `git -c`/`git -C`/`git config`, and for a one-word
 * command. Compound and complex commands, and commands containing `*`, get no rule. `bun test`
 * is the one prefix rule kept for `bun` (it is the project's test runner).
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
  const bunTest = program === 'bun' && second === 'test'
  const risky =
    (WRAPPERS.has(program) && !bunTest) ||
    /^python[\d.]*$/.test(program) ||
    second.startsWith('-') ||
    (program === 'git' && second === 'config')
  return risky ? `Bash(${first})` : `Bash(${words[0]} ${second} *)`
}

/**
 * The permission engine with the extras the permissions plugin uses (not part of the shared
 * `PermissionEngine` contract).
 */
export interface PermissionEngineExtras extends PermissionEngine {
  /** The mode that was active before plan mode was entered (`default` when unknown). */
  modeBeforePlan(): PermissionMode
  /**
   * True when a `Read` deny or ask rule (the built-in `.env*` ask included, unless an allow rule
   * names the path) matches a virtual path: the plugin hides such paths from `grep`,
   * `list_files` and `glob` output.
   */
  readBlocked(virtualPath: string): boolean
}

/** Read a settings file as an object; `undefined` when it is missing or not an object. */
async function readSettings(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsedFile: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsedFile === 'object' && parsedFile !== null && !Array.isArray(parsedFile)) {
      return parsedFile as Record<string, unknown>
    }
  } catch {
    // missing or unreadable
  }
  return undefined
}

/**
 * Create the permission engine.
 *
 * @param opts.config - Settings merged with the CLI flags (initial mode and rules).
 * @param opts.mounts - Current mounts of the virtual tree (directories can be added at runtime).
 */
export function createPermissionEngine(opts: {
  config: CoderConfig
  mounts: () => Mount[]
}): PermissionEngineExtras {
  const { config } = opts
  let mode: PermissionMode = config.mode
  let beforePlan: PermissionMode = 'default'
  const rules: PermissionRules = {
    allow: [...config.rules.allow],
    ask: [...config.rules.ask],
    deny: [...config.rules.deny],
  }
  const listeners = new Set<(mode: PermissionMode) => void>()
  const parsedCache = new Map<string, ParsedRule | undefined>()

  const parsed = (list: readonly string[]): ParsedRule[] => {
    const out: ParsedRule[] = []
    for (const raw of list) {
      if (!parsedCache.has(raw)) parsedCache.set(raw, parseRule(raw))
      const rule = parsedCache.get(raw)
      if (rule !== undefined) out.push(rule)
    }
    return out
  }
  const builtinAsk = parsed(BUILTIN_ASK)
  const context = (): MatchContext => ({
    root: config.root,
    home: homedir(),
    mounts: opts.mounts(),
  })

  const modeDefault = (
    call: ToolCallInfo,
    m: PermissionMode,
    ctx: MatchContext,
  ): PermissionDecision => {
    const name = call.toolName
    if (READ_PATH_TOOLS.includes(name)) {
      const target = callTarget(call, ctx.mounts)
      if (target === undefined) return { status: 'denied', reason: 'Invalid path.' }
      if (target === null) {
        return { status: 'denied', reason: 'The path is outside the working directories.' }
      }
      return { status: 'approved' }
    }
    if (EDIT_PATH_TOOLS.includes(name)) {
      const target = callTarget(call, ctx.mounts)
      if (target === undefined) return { status: 'denied', reason: 'Invalid path.' }
      if (target === null) {
        return { status: 'denied', reason: 'The path is outside the working directories.' }
      }
      if (target.mount.readonly) {
        return { status: 'denied', reason: 'That directory is read-only.' }
      }
      return m === 'acceptEdits' || m === 'bypassPermissions'
        ? { status: 'approved' }
        : { status: 'user-approval' }
    }
    if (name === TOOL.bash) {
      const command = (call.input as { command?: unknown } | null)?.command
      if (typeof command !== 'string') return { status: 'user-approval' }
      if (isReadOnlyCommand(command)) {
        const problem = m === 'bypassPermissions' ? undefined : readPathProblem(command, ctx)
        return problem === undefined
          ? { status: 'approved' }
          : { status: 'user-approval', reason: problem }
      }
      if (m === 'bypassPermissions') return { status: 'approved' }
      if (m === 'acceptEdits' && isAcceptedFileCommand(command, ctx)) return { status: 'approved' }
      return { status: 'user-approval' }
    }
    if (name === TOOL.agent || READ_ONLY_TOOLS.includes(name)) return { status: 'approved' }
    return m === 'bypassPermissions' ? { status: 'approved' } : { status: 'user-approval' }
  }

  /** Why an allow rule must not approve this bash command: its write targets, or `undefined`. */
  const allowBlocker = (
    call: ToolCallInfo,
    targets: string[],
    ctx: MatchContext,
  ): string | undefined => {
    if (call.toolName !== TOOL.bash) return undefined
    const command = (call.input as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return undefined
    const raw = parseCommand(command).redirects.filter((t) => t !== NULL_DEVICE)
    if (raw.some(unresolvable)) return 'writes to a path that cannot be resolved statically'
    const writable = ctx.mounts.filter((m) => !m.readonly).map((m) => m.real)
    for (const real of targets) {
      if (!writable.some((dir) => isInside(real, dir))) {
        return 'writes outside the working directories'
      }
    }
    return undefined
  }

  const evaluate = (call: ToolCallInfo, m: PermissionMode): PermissionDecision => {
    const ctx = context()
    const name = call.toolName
    const targets = writeTargets(call, ctx)
    const bashCommand = (call.input as { command?: unknown } | null)?.command
    const bash = name === TOOL.bash && typeof bashCommand === 'string' ? bashCommand : undefined
    const readRule = (list: ParsedRule[]): ParsedRule | undefined =>
      bash === undefined ? undefined : readRuleForCommand(list, bash, ctx)
    const coverRule = (list: ParsedRule[]): ParsedRule | undefined =>
      bash === undefined ? undefined : readRuleCovering(list, bash, ctx)
    const editRules = (list: ParsedRule[]): ParsedRule | undefined =>
      list.find((rule) => targets.some((real) => editRuleMatchesPath(rule, real, ctx)))

    // 1. deny rules
    const denies = parsed(rules.deny)
    const denied =
      denies.find((rule) => ruleMatchesCall(rule, call, 'restrict', ctx)) ??
      (bash !== undefined ? (editRules(denies) ?? readRule(denies)) : undefined)
    if (denied !== undefined) {
      return { status: 'denied', rule: denied.raw, reason: `Denied by the rule ${denied.raw}.` }
    }

    // 2. tools that always ask
    if (name === TOOL.dirAccess) {
      return { status: 'user-approval', reason: 'Access to a new directory always needs approval.' }
    }
    if (name === TOOL.exitPlan) {
      if (m !== 'plan') {
        return { status: 'denied', reason: 'exit_plan_mode is only available in plan mode.' }
      }
      return { status: 'user-approval', reason: 'The user must approve the plan.' }
    }

    // 3. plan mode: reads and read-only commands only
    if (m === 'plan' && name !== TOOL.agent && !READ_ONLY_TOOLS.includes(name)) {
      if (!(bash !== undefined && isReadOnlyCommand(bash))) {
        return { status: 'denied', reason: PLAN_MODE_REASON }
      }
    }

    // 4. protected paths ask in every mode (bypassPermissions included)
    if (targets.some((real) => isProtectedPath(real, ctx.mounts))) {
      return {
        status: 'user-approval',
        reason: 'Protected path (.git, .coder settings and agents): always asks.',
      }
    }
    if (bash !== undefined && !isReadOnlyCommand(bash)) {
      const parsedCommand = parseCommand(bash)
      if (PROTECTED_TEXT.test(`${bash}\n${parsedCommand.subcommands.join('\n')}`)) {
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
        asks.find((rule) => ruleMatchesCall(rule, call, 'restrict', ctx)) ??
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
    const allow = parsed(rules.allow).find((rule) => ruleMatchesCall(rule, call, 'allow', ctx))
    if (allow !== undefined) {
      const blocker = allowBlocker(call, targets, ctx)
      if (blocker !== undefined) {
        return { status: 'user-approval', rule: allow.raw, reason: blocker }
      }
      return { status: 'approved', rule: allow.raw }
    }

    // 7. built-in ask rules (an allow rule above overrides them)
    if (m !== 'bypassPermissions') {
      const soft =
        builtinAsk.find((rule) => ruleMatchesCall(rule, call, 'restrict', ctx)) ??
        readRule(builtinAsk)
      if (soft !== undefined) {
        return {
          status: 'user-approval',
          rule: soft.raw,
          reason: 'Environment files may hold secrets: asks first.',
        }
      }
      const coveredSoft = coverRule(builtinAsk)
      if (coveredSoft !== undefined) {
        return {
          status: 'user-approval',
          rule: coveredSoft.raw,
          reason: COVER_REASON(coveredSoft),
        }
      }
    }

    // 8. mode default
    return modeDefault(call, m, ctx)
  }

  const inactive = (m: PermissionMode): string[] => {
    const out = new Set<string>()
    if (m === 'plan') {
      for (const name of TOOL_ORDER) {
        if (
          !READ_ONLY_TOOLS.includes(name) &&
          name !== TOOL.exitPlan &&
          name !== TOOL.agent &&
          name !== TOOL.bash
        ) {
          out.add(name)
        }
      }
    } else {
      out.add(TOOL.exitPlan)
    }
    for (const rule of parsed(rules.deny)) {
      if (rule.specifier === undefined) for (const t of toolsForRuleTool(rule.tool)) out.add(t)
    }
    return [...out]
  }

  const setMode = (next: PermissionMode): void => {
    if (next === mode) return
    if (next === 'plan') beforePlan = mode
    mode = next
    for (const listener of [...listeners]) listener(mode)
  }

  /** Read/write the local settings file's `permissions` object; `write` returns whether to save. */
  const editLocal = async (
    create: boolean,
    edit: (permissions: Record<string, unknown>) => boolean,
  ): Promise<boolean> => {
    const file = config.settingsFiles.local
    const existing = await readSettings(file)
    if (existing === undefined && !create) return false
    const settings = existing ?? {}
    const permissions =
      typeof settings.permissions === 'object' &&
      settings.permissions !== null &&
      !Array.isArray(settings.permissions)
        ? (settings.permissions as Record<string, unknown>)
        : {}
    const changed = edit(permissions)
    if (!changed && existing !== undefined) return false
    settings.permissions = permissions
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
    return changed
  }

  const addRule = async (
    kind: keyof PermissionRules,
    rule: string,
    scope: 'session' | 'project',
  ): Promise<void> => {
    const clean = rule.trim()
    if (parseRule(clean) === undefined) throw new Error(`Invalid permission rule: ${rule}`)
    if (!rules[kind].includes(clean)) rules[kind].push(clean)
    if (scope !== 'project') return
    await editLocal(true, (permissions) => {
      const list = Array.isArray(permissions[kind]) ? (permissions[kind] as unknown[]) : []
      if (!list.includes(clean)) list.push(clean)
      permissions[kind] = list
      return true
    })
  }

  return {
    get mode(): PermissionMode {
      return mode
    },
    setMode,
    modeBeforePlan(): PermissionMode {
      return beforePlan === 'plan' ? 'default' : beforePlan
    },
    cycleMode(): PermissionMode {
      const index = MODE_CYCLE.indexOf(mode)
      const next =
        index < 0 ? 'default' : (MODE_CYCLE[(index + 1) % MODE_CYCLE.length] as PermissionMode)
      setMode(next)
      return next
    },
    decide(call: ToolCallInfo, modeOverride?: PermissionMode): PermissionDecision {
      const m = modeOverride ?? mode
      const decision = evaluate(call, m)
      // the global dontAsk also turns the asks of a per-agent mode override into denials
      if ((m === 'dontAsk' || mode === 'dontAsk') && decision.status === 'user-approval') {
        const out: PermissionDecision = { status: 'denied', reason: DONT_ASK_REASON }
        if (decision.rule !== undefined) out.rule = decision.rule
        return out
      }
      return decision
    },
    suggestRule(call: ToolCallInfo): string | undefined {
      const name = call.toolName
      if (name === TOOL.exitPlan || name === TOOL.dirAccess) return undefined
      const ctx = context()
      if (writeTargets(call, ctx).some((real) => isProtectedPath(real, ctx.mounts))) {
        return undefined
      }
      if (name === TOOL.bash) {
        const command = (call.input as { command?: unknown } | null)?.command
        if (typeof command !== 'string' || PROTECTED_TEXT.test(command)) return undefined
        return bashSuggestion(command)
      }
      if (EDIT_PATH_TOOLS.includes(name)) return 'Edit'
      return name
    },
    async allow(rule: string, scope: 'session' | 'project'): Promise<void> {
      if (parseRule(rule.trim()) === undefined) return
      await addRule('allow', rule, scope)
    },
    addRule,
    async removeRule(kind: keyof PermissionRules, rule: string): Promise<boolean> {
      const clean = rule.trim()
      const index = rules[kind].indexOf(clean)
      if (index !== -1) rules[kind].splice(index, 1)
      const inFile = await editLocal(false, (permissions) => {
        const list = permissions[kind]
        if (!Array.isArray(list) || !list.includes(clean)) return false
        permissions[kind] = list.filter((entry) => entry !== clean)
        return true
      })
      return index !== -1 || inFile
    },
    rules(): PermissionRules {
      return { allow: [...rules.allow], ask: [...rules.ask], deny: [...rules.deny] }
    },
    inactiveTools(modeOverride?: PermissionMode): string[] {
      return inactive(modeOverride ?? mode)
    },
    subscribe(listener: (mode: PermissionMode) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    readBlocked(virtualPath: string): boolean {
      const ctx = context()
      const target = toRealPath(virtualPath, ctx.mounts)
      if (target === undefined) return false
      const matches = (rule: ParsedRule): boolean =>
        rule.specifier !== undefined && pathMatchesSpecifier(rule.specifier, target.real, ctx)
      const reads = (list: readonly string[]): ParsedRule[] => readRulesOf(parsed(list))
      if (reads(rules.deny).some(matches) || reads(rules.ask).some(matches)) return true
      return readRulesOf(builtinAsk).some(matches) && !reads(rules.allow).some(matches)
    },
  }
}
