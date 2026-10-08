/**
 * Permission rules: `Tool` and `Tool(specifier)` strings, how they map onto tool names, and how
 * they match a tool call.
 *
 * Syntax:
 * - `Bash(bun test *)`: `*` matches any text; a trailing ` *` also matches the bare command;
 *   a trailing `:*` is the same as ` *`. An allow rule must match every subcommand and never
 *   matches a complex command; deny and ask rules match when any subcommand matches.
 * - `Read(.env*)`, `Edit(src/**)`: gitignore patterns. `//abs/path` is an absolute path,
 *   `~/x` is relative to the home directory, `/x` and `./x` are relative to the project root,
 *   `x` follows gitignore (a pattern without a slash matches at any depth).
 * - `Agent(name)`: the `subagent_type` of the call.
 * - Tool aliases: `Read` = read_file, list_files, grep, glob; `Edit` (and `Write`) = edit_file,
 *   write_file, delete_file; `Bash` = bash; `Agent` = agent. Real tool names work too.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { type Mount, TOOL, type ToolCallInfo } from '../contracts.ts'
import { parseCommand } from './bash-match.ts'

/** A parsed rule string. */
export interface ParsedRule {
  /** The rule as written. */
  raw: string
  /** Tool part: an alias (`Edit`), a tool name (`edit_file`) or an `mcp__…` name. */
  tool: string
  /** Text inside the parentheses, when present. */
  specifier?: string
}

/** Where a rule is evaluated: project root, home directory and the mounts of the virtual tree. */
export interface MatchContext {
  root: string
  home?: string
  mounts: Mount[]
}

/** Whether a rule is matched as an allow rule or as a deny/ask rule. */
export type Polarity = 'allow' | 'restrict'

const ALIASES: Record<string, readonly string[]> = {
  Read: [TOOL.read, TOOL.list, TOOL.grep, TOOL.glob],
  Edit: [TOOL.edit, TOOL.write, TOOL.delete],
  Write: [TOOL.edit, TOOL.write, TOOL.delete],
  Bash: [TOOL.bash],
  Agent: [TOOL.agent],
}

/** Tools that read files (inputs carry a virtual path in `path` or `prefix`). */
export const READ_PATH_TOOLS: readonly string[] = ALIASES.Read as readonly string[]
/** Tools that modify files (inputs carry a virtual `path`). */
export const EDIT_PATH_TOOLS: readonly string[] = ALIASES.Edit as readonly string[]

/**
 * Parse `Tool` or `Tool(specifier)`. Returns `undefined` for anything else (such rules are
 * ignored).
 */
export function parseRule(raw: string): ParsedRule | undefined {
  const text = raw.trim()
  const match = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(text)
  if (match === null) return undefined
  const rule: ParsedRule = { raw: text, tool: match[1] as string }
  if (match[2] !== undefined && match[2] !== '') rule.specifier = match[2]
  return rule
}

/** Tool names a rule's tool part stands for (alias expansion; other names verbatim). */
export function toolsForRuleTool(tool: string): readonly string[] {
  return ALIASES[tool] ?? [tool]
}

/** True when `tool` (alias or name) covers the tool called `toolName`. */
export function ruleToolMatches(tool: string, toolName: string): boolean {
  return toolsForRuleTool(tool).includes(toolName)
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wildcard match where `*` matches any text (including nothing); other characters are literal. */
export function matchWildcard(pattern: string, text: string): boolean {
  if (!pattern.includes('*')) return pattern === text
  const source = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${source}$`, 's').test(text)
}

/**
 * Match a Bash rule specifier against one normalised subcommand: everything before the first `*`
 * is literal, `*` matches any text, and a trailing ` *` (the only wildcard) also matches the bare
 * command. A trailing `:*` is treated as ` *`.
 */
export function matchBashSpec(specifier: string, subcommand: string): boolean {
  const spec = specifier.endsWith(':*') ? `${specifier.slice(0, -2)} *` : specifier
  const text = subcommand.trim()
  if (matchWildcard(spec, text)) return true
  if (spec.endsWith(' *') && !spec.slice(0, -2).includes('*')) return text === spec.slice(0, -2)
  return false
}

/**
 * Map a virtual path to a real path with the mounts (longest virtual prefix wins). Returns
 * `undefined` when no mount contains it.
 */
export function toRealPath(
  virtualPath: string,
  mounts: readonly Mount[],
): { real: string; mount: Mount } | undefined {
  const p = posix.normalize(`/${virtualPath}`).replace(/\/+$/, '')
  const probe = `${p}/`
  let best: Mount | undefined
  for (const mount of mounts) {
    if (
      probe.startsWith(mount.virtual) &&
      (best === undefined || mount.virtual.length > best.virtual.length)
    ) {
      best = mount
    }
  }
  if (best === undefined) return undefined
  const rest = probe.slice(best.virtual.length).replace(/\/+$/, '')
  return { real: rest === '' ? best.real : join(best.real, rest), mount: best }
}

/** The virtual path argument of a file tool call (`path`, or `prefix`; default `/` for lookups). */
function virtualPathOf(call: ToolCallInfo): string | undefined {
  const input = call.input
  if (typeof input !== 'object' || input === null) return undefined
  const fields = input as Record<string, unknown>
  const value = fields.path ?? fields.prefix
  if (typeof value === 'string' && value !== '') return value
  if (value === undefined && [TOOL.list, TOOL.grep, TOOL.glob].includes(call.toolName as never)) {
    return '/'
  }
  return undefined
}

/**
 * The real path a file tool call touches, with its mount. `undefined` for a missing or invalid
 * path, `null` when the path is outside every mount.
 */
export function callTarget(
  call: ToolCallInfo,
  mounts: readonly Mount[],
): { real: string; mount: Mount } | null | undefined {
  const virtual = virtualPathOf(call)
  if (virtual === undefined) return undefined
  return toRealPath(virtual, mounts) ?? null
}

const matchers = new Map<string, Ignore>()

function compiled(pattern: string): Ignore {
  let ig = matchers.get(pattern)
  if (ig === undefined) {
    ig = ignore().add(pattern)
    matchers.set(pattern, ig)
  }
  return ig
}

/** Base directory and gitignore pattern of a path specifier. */
function resolveSpecifier(specifier: string, ctx: MatchContext): { base: string; pattern: string } {
  if (specifier.startsWith('//')) return { base: '/', pattern: specifier.slice(1) }
  if (specifier.startsWith('~/')) {
    return { base: ctx.home ?? homedir(), pattern: `/${specifier.slice(2)}` }
  }
  if (specifier.startsWith('/')) return { base: ctx.root, pattern: specifier }
  if (specifier.startsWith('./')) return { base: ctx.root, pattern: `/${specifier.slice(2)}` }
  return { base: ctx.root, pattern: specifier }
}

/** True for a gitignore pattern without a slash (except a trailing one): it matches at any depth. */
function isAnyDepth(specifier: string): boolean {
  if (/^(\/\/|~\/|\/|\.\/|!)/.test(specifier)) return false
  return !specifier.replace(/\/+$/, '').includes('/')
}

/** Real directories a rule can be anchored in: the project root and every mount. */
function anchorDirs(ctx: MatchContext): string[] {
  return [...new Set([ctx.root, ...ctx.mounts.map((m) => m.real)])]
}

/**
 * Match an absolute real path against a path specifier (gitignore semantics). `//abs` and `~/x`
 * are absolute, `/x`, `./x` and `a/b` are anchored at the project root, and a bare pattern
 * (`.env*`, no slash) applies at any depth in the project root AND inside every mount.
 */
export function pathMatchesSpecifier(
  specifier: string,
  realPath: string,
  ctx: MatchContext,
): boolean {
  const { base, pattern } = resolveSpecifier(specifier, ctx)
  const bases = isAnyDepth(specifier) ? [base, ...anchorDirs(ctx)] : [base]
  for (const dir of new Set(bases)) {
    const rel = relative(dir, realPath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      if (compiled(pattern).ignores(rel.split('\\').join('/'))) return true
    } catch {
      // not a valid relative path
    }
  }
  return false
}

// ─── could a rule match something under / matched by a path? ────────────────────────────────

/**
 * Tokens of a single path segment pattern: `?` and `*` are wildcards, `[…]` is over-approximated
 * as `?`. With `shell`, the segment is a shell glob: a leading wildcard never matches a leading
 * dot (`*.ts` does not match `.env.ts`), written as the token `N` (any character but a dot).
 */
function segmentTokens(segment: string, shell = false): string[] {
  const out: string[] = []
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string
    if (ch === '*') {
      if (out[out.length - 1] !== '*') out.push('*')
    } else if (ch === '?') {
      out.push('?')
    } else if (ch === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end === -1) {
        out.push('[')
      } else {
        out.push('?')
        i = end
      }
    } else if (ch === '\\' && i + 1 < segment.length) {
      out.push(`=${segment[++i]}`)
    } else {
      out.push(`=${ch}`)
    }
  }
  if (shell && (out[0] === '*' || out[0] === '?'))
    out.splice(0, 1, 'N', ...(out[0] === '*' ? ['*'] : []))
  return out
}

/** Do two single-segment glob patterns have a common string? (`*` any run, `?` any char.) */
function segmentsIntersect(a: string, b: string): boolean {
  const A = segmentTokens(a)
  const B = segmentTokens(b, true)
  const seen = new Map<number, boolean>()
  const reach = (i: number, j: number): boolean => {
    const key = i * (B.length + 1) + j
    const cached = seen.get(key)
    if (cached !== undefined) return cached
    seen.set(key, false)
    let result = false
    if (i === A.length && j === B.length) {
      result = true
    } else {
      const x = A[i]
      const y = B[j]
      if (x === '*') result = reach(i + 1, j) || (y !== undefined && reach(i, j + 1))
      if (!result && y === '*') result = reach(i, j + 1) || (x !== undefined && reach(i + 1, j))
      if (!result && x !== undefined && y !== undefined && x !== '*' && y !== '*') {
        const compatible =
          x === y ||
          x === '?' ||
          y === '?' ||
          (x === 'N' && y !== '=.') ||
          (y === 'N' && x !== '=.')
        result = compatible && reach(i + 1, j + 1)
      }
    }
    seen.set(key, result)
    return result
  }
  return reach(0, 0)
}

/** Do two segment lists (`**` = any number of segments) have a common path? */
function pathsIntersect(rule: readonly string[], target: readonly string[]): boolean {
  const seen = new Map<number, boolean>()
  const reach = (i: number, j: number): boolean => {
    const key = i * (target.length + 1) + j
    const cached = seen.get(key)
    if (cached !== undefined) return cached
    seen.set(key, false)
    let result = false
    const r = rule[i]
    const t = target[j]
    if (r === undefined && t === undefined) {
      result = true
    } else if (r === '**') {
      result = reach(i + 1, j) || (t !== undefined && reach(i, j + 1))
    } else if (t === '**') {
      result = reach(i, j + 1) || (r !== undefined && reach(i + 1, j))
    } else if (r !== undefined && t !== undefined) {
      result = segmentsIntersect(r, t) && reach(i + 1, j + 1)
    }
    seen.set(key, result)
    return result
  }
  return reach(0, 0)
}

const splitSegments = (path: string): string[] => path.split('/').filter((s) => s !== '')

/** Absolute segment patterns a path specifier stands for (a rule covers the subtree it matches). */
function ruleSegments(specifier: string, ctx: MatchContext): string[][] {
  if (specifier.startsWith('!')) return []
  const trimmed = specifier.replace(/\/+$/, '')
  if (isAnyDepth(specifier)) {
    return anchorDirs(ctx).map((dir) => [
      ...splitSegments(dir),
      '**',
      ...splitSegments(trimmed),
      '**',
    ])
  }
  const { base, pattern } = resolveSpecifier(trimmed, ctx)
  return [[...splitSegments(base), ...splitSegments(pattern), '**']]
}

/**
 * Whether a path specifier could match something that `target` stands for: the path itself, or
 * (with `subtree`) anything below it. `target` is an absolute real path whose segments may be
 * glob patterns (`/proj/.e*`). Conservative: character classes count as `?`, and an unparsable
 * pattern counts as a match.
 */
export function specifierCouldMatch(
  specifier: string,
  target: string,
  subtree: boolean,
  ctx: MatchContext,
): boolean {
  const segments = splitSegments(target)
  if (subtree) segments.push('**')
  return ruleSegments(specifier, ctx).some((rule) => pathsIntersect(rule, segments))
}

/**
 * Whether a rule matches a tool call. Without a specifier the rule covers the whole tool.
 *
 * @param polarity - `allow` rules are strict (every subcommand, never complex); `restrict` (deny
 * and ask) rules match when any subcommand or path matches.
 */
export function ruleMatchesCall(
  rule: ParsedRule,
  call: ToolCallInfo,
  polarity: Polarity,
  ctx: MatchContext,
): boolean {
  if (!ruleToolMatches(rule.tool, call.toolName)) return false
  const specifier = rule.specifier
  if (specifier === undefined) return true
  if (call.toolName === TOOL.bash) {
    const command = (call.input as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return false
    const parsed = parseCommand(command)
    if (polarity === 'allow') {
      return (
        !parsed.complex &&
        parsed.subcommands.length > 0 &&
        parsed.subcommands.every((sub) => matchBashSpec(specifier, sub))
      )
    }
    return (
      parsed.subcommands.some((sub) => matchBashSpec(specifier, sub)) ||
      matchBashSpec(specifier, command)
    )
  }
  if (call.toolName === TOOL.agent) {
    const type = (call.input as { subagent_type?: unknown } | null)?.subagent_type
    return typeof type === 'string' && matchWildcard(specifier, type)
  }
  if (READ_PATH_TOOLS.includes(call.toolName) || EDIT_PATH_TOOLS.includes(call.toolName)) {
    const target = callTarget(call, ctx.mounts)
    if (target === undefined || target === null) return false
    return pathMatchesSpecifier(specifier, target.real, ctx)
  }
  return false
}
