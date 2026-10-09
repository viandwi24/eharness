/**
 * Permission rules: `Tool` and `Tool(specifier)` strings, how they map onto tools, and how they
 * match a tool call (spec 18 §2).
 *
 * - `Bash(bun test *)`: `*` matches any text; a trailing ` *` also matches the bare command; a
 *   trailing `:*` is the same as ` *`. An allow rule must match every subcommand and never
 *   matches a complex command; deny and ask rules match when any subcommand matches.
 * - `Read(.env*)`, `Edit(src/**)`: gitignore patterns. `//abs/path` is an absolute path, `~/x`
 *   is relative to the home directory, `/x` and `./x` are relative to the project root, `x`
 *   follows gitignore (a pattern without a slash matches at any depth).
 * - `Agent(name)`: the name field of the call (`subagent_type`).
 * - `WebFetch(domain:example.com)`: the host of the URL; `domain:*.example.com` its subdomains.
 * - The tool part is an alias (`Read`, `Edit`, `Bash`, …, see `DEFAULT_ALIASES`) or a tool name.
 */

import { parseCommand } from './command.ts'
import { cachedPattern, isAbsolute, join, normalize, patternMatches, relative } from './paths.ts'
import {
  commandOf,
  createToolTable,
  fieldOf,
  type Roots,
  type ToolTable,
  virtualPathOf,
  withSlash,
} from './tools.ts'
import type { PermissionCall, PermissionRoot, ToolKinds } from './types.ts'

/** A parsed rule string. */
export interface ParsedRule {
  /** The rule as written. */
  raw: string
  /** Tool part: an alias (`Edit`), a tool name (`edit_file`) or an `mcp__…` name. */
  tool: string
  /** Text inside the parentheses, when present. */
  specifier?: string
}

/** Where a rule is evaluated: project root, home directory, the roots of the virtual tree, the tool map. */
export interface MatchContext {
  /** Real path of the project root (the root mounted at `/`, else the first root). */
  root: string
  home?: string
  roots: Roots
  tools: ToolTable
}

/** Whether a rule is matched as an allow rule or as a deny/ask rule. */
export type Polarity = 'allow' | 'restrict'

/**
 * Whether a `domain:` specifier of a `WebFetch` rule matches a host. `example.com` matches that
 * host only, `*.example.com` its subdomains. Anything not starting with `domain:` matches nothing.
 */
export function domainSpecifierMatches(specifier: string, host: string): boolean {
  if (!specifier.startsWith('domain:')) return false
  const pattern = specifier.slice('domain:'.length).trim().toLowerCase()
  const name = host.toLowerCase().replace(/\.$/, '')
  if (pattern === '') return false
  if (pattern.startsWith('*.'))
    return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1
  return name === pattern
}

/** Host of a URL (`https://` is assumed when there is no scheme), if it parses. */
export function urlHost(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname
  } catch {
    return undefined
  }
}

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
 * Map a virtual path to a real path with the roots (longest virtual prefix wins). Returns
 * `undefined` when no root contains it.
 */
export function toRealPath(
  virtualPath: string,
  roots: Roots,
): { real: string; root: PermissionRoot } | undefined {
  const p = normalize(`/${virtualPath}`).replace(/\/+$/, '')
  const probe = `${p}/`
  let best: PermissionRoot | undefined
  let bestVirtual = ''
  for (const root of roots) {
    const virtual = withSlash(normalize(`/${root.virtual}`))
    if (probe.startsWith(virtual) && (best === undefined || virtual.length > bestVirtual.length)) {
      best = root
      bestVirtual = virtual
    }
  }
  if (best === undefined) return undefined
  const rest = probe.slice(bestVirtual.length).replace(/\/+$/, '')
  return { real: rest === '' ? normalize(best.real) : join(best.real, rest), root: best }
}

/**
 * The real path a file tool call touches, with its root. `undefined` for a missing or invalid
 * path, `null` when the path is outside every root.
 */
export function callTarget(
  call: PermissionCall,
  ctx: MatchContext,
): { real: string; root: PermissionRoot } | null | undefined {
  const virtual = virtualPathOf(call, ctx.tools.spec(call.toolName))
  if (virtual === undefined) return undefined
  return toRealPath(virtual, ctx.roots) ?? null
}

/** Base directory and gitignore pattern of a path specifier. */
function resolveSpecifier(
  specifier: string,
  ctx: MatchContext,
): { base: string; pattern: string } | undefined {
  if (specifier.startsWith('//')) return { base: '/', pattern: specifier.slice(1) }
  if (specifier.startsWith('~/')) {
    if (ctx.home === undefined) return undefined
    return { base: ctx.home, pattern: `/${specifier.slice(2)}` }
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

/** Real directories a rule can be anchored in: the project root and every root. */
function anchorDirs(ctx: MatchContext): string[] {
  return [...new Set([ctx.root, ...ctx.roots.map((r) => normalize(r.real))])]
}

/**
 * Match an absolute real path against a path specifier (gitignore semantics). `//abs` and `~/x`
 * are absolute, `/x`, `./x` and `a/b` are anchored at the project root, and a bare pattern
 * (`.env*`, no slash) applies at any depth in the project root AND inside every root.
 */
export function pathMatchesSpecifier(
  specifier: string,
  realPath: string,
  ctx: MatchContext,
): boolean {
  const resolved = resolveSpecifier(specifier, ctx)
  if (resolved === undefined) return false
  const compiled = cachedPattern(resolved.pattern)
  if (compiled === undefined) return false
  const bases = isAnyDepth(specifier) ? [resolved.base, ...anchorDirs(ctx)] : [resolved.base]
  for (const dir of new Set(bases)) {
    const rel = relative(dir, realPath)
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue
    if (patternMatches(compiled, rel)) return true
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
  const resolved = resolveSpecifier(trimmed, ctx)
  if (resolved === undefined) return []
  const { base, pattern } = resolved
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
  call: PermissionCall,
  polarity: Polarity,
  ctx: MatchContext,
): boolean {
  if (!ctx.tools.covers(rule.tool, call.toolName)) return false
  const specifier = rule.specifier
  if (specifier === undefined) return true
  const spec = ctx.tools.spec(call.toolName)
  switch (spec?.kind) {
    case 'shell': {
      const command = commandOf(call, spec)
      if (command === undefined) return false
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
    case 'fetch': {
      const host = urlHost(fieldOf(call.input, spec.urlField ?? 'url'))
      return host !== undefined && domainSpecifierMatches(specifier, host)
    }
    case 'agent': {
      const name = fieldOf(call.input, spec.nameField ?? 'subagent_type')
      return name !== undefined && matchWildcard(specifier, name)
    }
    case 'read':
    case 'write': {
      const target = callTarget(call, ctx)
      if (target === undefined || target === null) return false
      return pathMatchesSpecifier(specifier, target.real, ctx)
    }
    default:
      return false
  }
}

/** Options of {@link matchRule}. */
export interface MatchRuleOptions {
  /** The directories of the virtual tree (see `PermissionRoot`). */
  roots: readonly PermissionRoot[]
  home?: string
  /** `allow` (strict: every subcommand, never complex) or `restrict` (deny/ask: any match). Default `restrict`. */
  polarity?: Polarity
  toolKinds?: ToolKinds
  aliases?: Record<string, readonly string[]>
}

/**
 * Whether one rule string matches a tool call, without an engine. An unparsable rule matches
 * nothing.
 */
export function matchRule(rule: string, call: PermissionCall, options: MatchRuleOptions): boolean {
  const parsed = parseRule(rule)
  if (parsed === undefined) return false
  const roots = options.roots
  const project = roots.find((r) => normalize(`/${r.virtual}`) === '/') ?? roots[0]
  const ctx: MatchContext = {
    root: project === undefined ? '/' : normalize(project.real),
    roots,
    tools: createToolTable(options.toolKinds, options.aliases),
  }
  if (options.home !== undefined) ctx.home = normalize(options.home)
  return ruleMatchesCall(parsed, call, options.polarity ?? 'restrict', ctx)
}
