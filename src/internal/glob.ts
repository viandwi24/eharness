/**
 * The one glob compiler of the library (spec 08 §3, spec 18 §5): the `glob` tool, permission rules
 * and ignore files, OpenAPI operation filters and provider model filters all compile through it.
 *
 * Dialects (options):
 *
 * - default: shell-like globs over `/`-separated relative paths: `**`, `*`, `?`, `[abc]` /
 *   `[!abc]` / `[a-z]` and `{a,b}`; the whole path must match.
 * - `gitignore`: gitignore syntax (see {@link compileGitignorePattern}); `*` and `?` match a
 *   leading dot, no braces.
 * - `wildcard`: only `*` (not across `/`) and `**` (anything); everything else is literal.
 *
 * Every dialect collapses consecutive `**` segments and caps the number of `**` and `*` per
 * pattern, so a pattern from model input cannot backtrack catastrophically.
 */

/** Options of the glob compiler. */
export interface GlobOptions {
  /** `*`, `?`, `[…]` and `**` may match a name that starts with `.`. Default `false` (shell-like). */
  dot?: boolean
  /** gitignore syntax (anchoring, `**` rules). Default `false`. */
  gitignore?: boolean
  /** Case-insensitive matching (the `i` flag; callers fold the tested path with `foldSegment`). */
  caseFold?: boolean
  /** Only `*` and `**` are special. Default `false`. */
  wildcard?: boolean
}

/** Result of {@link compileGlobRegExp}. */
export type GlobRegExpResult = { ok: true; regex: RegExp } | { ok: false; error: string }

/** Most alternatives one pattern may expand to through `{a,b}`. */
export const GLOB_MAX_BRACE_ALTERNATIVES = 64
/** Most `**` segments one pattern may keep after collapsing consecutive ones. */
export const GLOB_MAX_DOUBLE_STARS = 4
/** Most `*` runs one pattern may contain outside `**` segments. */
export const GLOB_MAX_STARS = 8

/** Expand `{a,b}` groups (nested allowed) into plain alternatives; `undefined` when too many. */
export function expandBraces(pattern: string): string[] | undefined {
  const open = findGroup(pattern)
  if (open === undefined) return [pattern]
  const { start, end, parts } = open
  const head = pattern.slice(0, start)
  const tail = pattern.slice(end + 1)
  const out: string[] = []
  for (const part of parts) {
    const expanded = expandBraces(head + part + tail)
    if (expanded === undefined) return undefined
    out.push(...expanded)
    if (out.length > GLOB_MAX_BRACE_ALTERNATIVES) return undefined
  }
  return out
}

/** The first top-level `{...}` group with its comma-separated parts (an unbalanced `{` is literal). */
function findGroup(pattern: string): { start: number; end: number; parts: string[] } | undefined {
  let search = 0
  for (;;) {
    const start = pattern.indexOf('{', search)
    if (start < 0) return undefined
    let depth = 0
    let inClass = false
    const parts: string[] = []
    let from = start + 1
    for (let i = start; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (inClass) continue
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          parts.push(pattern.slice(from, i))
          return parts.length > 1 ? { start, end: i, parts } : undefined
        }
      } else if (c === ',' && depth === 1) {
        parts.push(pattern.slice(from, i))
        from = i + 1
      }
    }
    search = start + 1
    if (search >= pattern.length) return undefined
  }
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

/** One segment (no `/`, not a `**` segment) as a regex source. */
function segmentSource(segment: string, dot: boolean): string {
  let out = dot || segment.startsWith('.') ? '' : '(?!\\.)'
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string
    if (c === '*') {
      while (segment[i + 1] === '*') i++
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const close = segment.indexOf(']', i + 2)
      if (close < 0) {
        out += '\\['
        continue
      }
      let body = segment.slice(i + 1, close)
      let negate = false
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true
        body = body.slice(1)
      }
      const ranges = body.replace(/[\\\]^[]/g, '\\$&')
      out += negate ? `[^/${ranges}]` : `[${ranges}]`
      i = close
    } else if (c === '\\' && i + 1 < segment.length) {
      out += escapeChar(segment[++i] as string)
    } else {
      out += escapeChar(c)
    }
  }
  return out
}

/** Number of `*` runs in a segment that is not `**`. */
function starRuns(segment: string): number {
  return (segment.match(/\*+/g) ?? []).length
}

/** `{ source }` of one brace-free alternative or `{ error }` when it breaks the caps. */
function alternativeSource(
  pattern: string,
  opts: { dot: boolean; gitignore: boolean },
): { source: string } | { error: string } {
  let segments = pattern.split('/').filter((s) => s !== '')
  // consecutive `**` segments are one
  segments = segments.filter((s, i) => !(s === '**' && segments[i - 1] === '**'))
  const doubles = segments.filter((s) => s === '**').length
  if (doubles > GLOB_MAX_DOUBLE_STARS) {
    return { error: `the pattern has more than ${GLOB_MAX_DOUBLE_STARS} "**" segments` }
  }
  const stars = segments.reduce((n, s) => n + (s === '**' ? 0 : starRuns(s)), 0)
  if (stars > GLOB_MAX_STARS) {
    return { error: `the pattern has more than ${GLOB_MAX_STARS} "*" wildcards` }
  }
  const part = opts.dot ? '[^/]+' : '(?!\\.)[^/]+'
  const parts: string[] = []
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      if (opts.gitignore) parts.push(last ? '.*' : '(?:.*/)?')
      else parts.push(last ? `(?:${part}/)*${part}` : `(?:${part}/)*`)
    } else {
      parts.push(segmentSource(segment, opts.dot) + (last ? '' : '/'))
    }
  })
  return { source: parts.join('') }
}

/** The `wildcard` dialect: `**` is `.*`, `*` is `[^/]*`, the rest is literal. */
function wildcardSource(pattern: string): { source: string } | { error: string } {
  let runs = 0
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i)
    if (c === '*') {
      let j = i
      while (pattern.charAt(j + 1) === '*') j++
      if (++runs > GLOB_MAX_STARS) {
        return { error: `the pattern has more than ${GLOB_MAX_STARS} "*" wildcards` }
      }
      source += j > i ? '.*' : '[^/]*'
      i = j
    } else source += escapeRegExp(c)
  }
  return { source }
}

/**
 * Compile a glob to a RegExp that must match the whole tested string (the `gitignore` dialect
 * anchors per gitignore rules instead, see {@link compileGitignorePattern}). Never throws: an
 * invalid or too expensive pattern returns `{ ok: false, error }`.
 *
 * @example
 * ```ts
 * const r = compileGlobRegExp('src/**\/*.ts', { dot: false })
 * r.ok && r.regex.test('src/a/b.ts') // true
 * ```
 */
export function compileGlobRegExp(pattern: string, options: GlobOptions = {}): GlobRegExpResult {
  const dot = options.dot ?? false
  const flags = options.caseFold === true ? 'i' : ''
  const sources: string[] = []
  if (options.wildcard === true) {
    const compiled = wildcardSource(pattern)
    if ('error' in compiled) return { ok: false, error: compiled.error }
    sources.push(compiled.source)
  } else {
    const alternatives = options.gitignore === true ? [pattern] : expandBraces(pattern)
    if (alternatives === undefined) {
      return {
        ok: false,
        error: `the pattern expands to more than ${GLOB_MAX_BRACE_ALTERNATIVES} alternatives`,
      }
    }
    for (const alternative of alternatives) {
      const compiled = alternativeSource(alternative, {
        dot,
        gitignore: options.gitignore === true,
      })
      if ('error' in compiled) return { ok: false, error: compiled.error }
      sources.push(compiled.source)
    }
  }
  try {
    return { ok: true, regex: new RegExp(`^(?:${sources.join('|')})$`, flags) }
  } catch {
    return { ok: false, error: 'the pattern is not a valid glob' }
  }
}

/** A compiled gitignore line. */
export interface GitignoreLine {
  /** A leading `!`: the line re-includes. */
  negate: boolean
  /** A trailing `/`: only directories match. */
  dirOnly: boolean
  regex: RegExp
}

/**
 * Compile one gitignore line; `undefined` for a blank line, a comment and a pattern that is
 * invalid or too expensive. Rules: a pattern without a `/` (except a trailing one) matches at any
 * depth, one with a `/` is anchored at the base (a leading `/` is dropped); a trailing `/` marks
 * directories only; `**` matches any number of directories; `*` and `?` match a leading dot;
 * `\#` and `\!` escape; trailing spaces are dropped unless escaped.
 *
 * @param caseFold Case-insensitive; the pattern is NFC-normalised (fold the tested segments with
 *   `foldSegment`).
 */
export function compileGitignorePattern(
  line: string,
  options: { caseFold?: boolean } = {},
): GitignoreLine | undefined {
  const ci = options.caseFold === true
  let p = line.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '')
  if (ci) p = p.normalize('NFC')
  if (p === '' || p.startsWith('#')) return undefined
  let negate = false
  if (p.startsWith('!')) {
    negate = true
    p = p.slice(1)
  } else if (p.startsWith('\\#') || p.startsWith('\\!')) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  p = p.replace(/\/+$/, '')
  if (p === '') return undefined
  const anchored = p.includes('/')
  p = p.replace(/^\/+/, '')
  const compiled = compileGlobRegExp(p, { gitignore: true, dot: true, caseFold: ci })
  if (!compiled.ok) return undefined
  // the whole-string anchors become gitignore's: anchored at the base, or at any depth
  const body = compiled.regex.source.slice('^(?:'.length, -')$'.length)
  try {
    return {
      negate,
      dirOnly,
      regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?(?:${body})$`, ci ? 'i' : ''),
    }
  } catch {
    return undefined
  }
}
