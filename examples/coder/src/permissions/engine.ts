/**
 * The permission engine: decides every tool call from rules and the mode
 * (docs/plans/P30-coder-example.md §6.2, §6.3).
 *
 * Evaluation order: deny rules, plan-mode gate, protected paths, ask rules, allow rules, built-in
 * ask rules (`.env*` reads, overridable by an allow rule), then the mode default.
 *
 * Read-only shell commands are not approved blindly: their path arguments (and `<` redirects) are
 * resolved lexically against the project root. They auto-approve only when every path is inside a
 * working directory (project root or an `/@dirs/*` mount, not the tool-outputs mount), none uses
 * an unresolvable expansion (`$VAR`, `~user`, brace expansion, `xargs` stdin) and none matches a
 * `Read` rule. A `Read` deny match denies the command, a `Read` ask match (including the built-in
 * `Read(.env*)`) or an outside path asks. This holds in default, plan and acceptEdits mode;
 * bypassPermissions skips the containment and ask checks (deny rules still apply).
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
import { isReadOnlyCommand, isReadOnlySubcommand, readPathArguments } from './readonly-commands.ts'
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
  toolsForRuleTool,
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

/** Path arguments of the read-only parts of a bash command (subcommands and `<` redirects). */
function bashReadAccess(command: string): { check: string[]; match: string[]; unsafe: boolean } {
  const parsed = parseCommand(command)
  const access = { check: [...parsed.inputs], match: [...parsed.inputs], unsafe: false }
  for (const sub of parsed.subcommands) {
    if (!isReadOnlySubcommand(sub)) continue
    const paths = readPathArguments(sub)
    access.check.push(...paths.check)
    access.match.push(...paths.match)
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

/** The first `Read` rule that matches a path read by a bash command. */
function readRuleForCommand(
  rules: readonly ParsedRule[],
  command: string,
  ctx: MatchContext,
): ParsedRule | undefined {
  const reals = bashReadAccess(command).match.map((arg) => shellPath(arg, ctx))
  if (reals.length === 0) return undefined
  return rules.find(
    (rule) =>
      ruleToolMatches(rule.tool, TOOL.read) &&
      (rule.specifier === undefined ||
        reals.some((real) => pathMatchesSpecifier(rule.specifier as string, real, ctx))),
  )
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

/** First two words of a command as an allow-rule prefix, or the exact command when one word. */
function bashSuggestion(command: string): string | undefined {
  const parsed = parseCommand(command)
  if (parsed.complex) return undefined
  const first = parsed.subcommands[0]
  if (first === undefined) return undefined
  const words = first.split(' ')
  if (words.length === 1) return `Bash(${first})`
  return `Bash(${words.slice(0, 2).join(' ')} *)`
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
}): PermissionEngine {
  const { config } = opts
  let mode: PermissionMode = config.mode
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

  const evaluate = (call: ToolCallInfo, m: PermissionMode): PermissionDecision => {
    const ctx = context()
    const name = call.toolName
    const targets = writeTargets(call, ctx)
    const bashCommand = (call.input as { command?: unknown } | null)?.command
    const readRule = (list: ParsedRule[]): ParsedRule | undefined =>
      name === TOOL.bash && typeof bashCommand === 'string'
        ? readRuleForCommand(list, bashCommand, ctx)
        : undefined
    const editRules = (list: ParsedRule[]): ParsedRule | undefined =>
      list.find((rule) => targets.some((real) => editRuleMatchesPath(rule, real, ctx)))

    // 1. deny rules
    const denies = parsed(rules.deny)
    const denied =
      denies.find((rule) => ruleMatchesCall(rule, call, 'restrict', ctx)) ??
      (call.toolName === TOOL.bash ? (editRules(denies) ?? readRule(denies)) : undefined)
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
      const command = (call.input as { command?: unknown } | null)?.command
      if (!(name === TOOL.bash && typeof command === 'string' && isReadOnlyCommand(command))) {
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

    // 5. ask rules
    if (m !== 'bypassPermissions') {
      const asks = parsed(rules.ask)
      const ask =
        asks.find((rule) => ruleMatchesCall(rule, call, 'restrict', ctx)) ??
        (call.toolName === TOOL.bash ? (editRules(asks) ?? readRule(asks)) : undefined)
      if (ask !== undefined) {
        return { status: 'user-approval', rule: ask.raw, reason: `Asks by the rule ${ask.raw}.` }
      }
    }

    // 6. allow rules
    const allow = parsed(rules.allow).find((rule) => ruleMatchesCall(rule, call, 'allow', ctx))
    if (allow !== undefined) return { status: 'approved', rule: allow.raw }

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
    mode = next
    for (const listener of [...listeners]) listener(mode)
  }

  return {
    get mode(): PermissionMode {
      return mode
    },
    setMode,
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
      if (m === 'dontAsk' && decision.status === 'user-approval') {
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
        return typeof command === 'string' ? bashSuggestion(command) : undefined
      }
      if (EDIT_PATH_TOOLS.includes(name)) return 'Edit'
      return name
    },
    async allow(rule: string, scope: 'session' | 'project'): Promise<void> {
      const clean = rule.trim()
      if (parseRule(clean) === undefined) return
      if (!rules.allow.includes(clean)) rules.allow.push(clean)
      if (scope !== 'project') return
      const file = config.settingsFiles.local
      let settings: Record<string, unknown> = {}
      try {
        const parsedFile: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (typeof parsedFile === 'object' && parsedFile !== null && !Array.isArray(parsedFile)) {
          settings = parsedFile as Record<string, unknown>
        }
      } catch {
        // missing or unreadable: start from an empty file
      }
      const permissions =
        typeof settings.permissions === 'object' && settings.permissions !== null
          ? (settings.permissions as Record<string, unknown>)
          : {}
      const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : []
      if (!allow.includes(clean)) allow.push(clean)
      permissions.allow = allow
      settings.permissions = permissions
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
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
  }
}
