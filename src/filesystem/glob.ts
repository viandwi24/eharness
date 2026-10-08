/**
 * A small glob matcher for the `glob` tool (spec 08 §3): `**`, `*`, `?`, `[abc]` / `[!abc]` /
 * `[a-z]` and `{a,b}`. Matching is over `/`-separated relative paths. A segment that does not
 * start with a literal `.` never matches a name that starts with one (dotfiles).
 *
 * @see docs/specs/08-filesystem-plugin.md#3-tools
 */

/** Most alternatives one pattern may expand to through `{a,b}`. */
const MAX_BRACE_ALTERNATIVES = 64
/** Longest pattern accepted. */
const MAX_PATTERN_LENGTH = 512

/** Result of {@link compileGlob}. */
export type CompiledGlob = { ok: true; test(path: string): boolean } | { ok: false; error: string }

/** Why a pattern may not be used, or `undefined`. */
export function globPatternProblem(pattern: string): string | undefined {
  if (pattern === '') return 'the pattern is empty'
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`
  }
  if (pattern.includes('\\')) return 'the pattern may not contain backslashes; use "/"'
  if (pattern.includes('\0')) return 'the pattern may not contain NUL'
  if (pattern.startsWith('/') || pattern.startsWith('~')) {
    return 'the pattern must be relative to `path` (no leading "/" or "~")'
  }
  if (pattern.split('/').includes('..')) return 'the pattern may not contain ".."'
  return undefined
}

/** Expand `{a,b}` groups (nested allowed) into plain alternatives; `undefined` when too many. */
function expandBraces(pattern: string): string[] | undefined {
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
    if (out.length > MAX_BRACE_ALTERNATIVES) return undefined
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

const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

/** One segment (no `/`, no `**` segment) as a regex source. */
function segmentSource(segment: string): string {
  let out = segment.startsWith('.') ? '' : '(?!\\.)'
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
    } else {
      out += escapeChar(c)
    }
  }
  return out
}

/** One brace-free alternative as a regex source (anchored by the caller). */
function alternativeSource(pattern: string): string {
  const segments = pattern.split('/').filter((s) => s !== '')
  const parts: string[] = []
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      parts.push(last ? '(?:(?!\\.)[^/]+/)*(?!\\.)[^/]+' : '(?:(?!\\.)[^/]+/)*')
    } else {
      parts.push(segmentSource(segment) + (last ? '' : '/'))
    }
  })
  return parts.join('')
}

/**
 * Compile a glob. `test(path)` takes a relative path with `/` separators (no leading `/`).
 * Invalid patterns return `{ ok: false, error }` (never throw).
 */
export function compileGlob(pattern: string): CompiledGlob {
  const problem = globPatternProblem(pattern)
  if (problem !== undefined) return { ok: false, error: problem }
  const alternatives = expandBraces(pattern)
  if (alternatives === undefined) {
    return {
      ok: false,
      error: `the pattern expands to more than ${MAX_BRACE_ALTERNATIVES} alternatives`,
    }
  }
  try {
    const regex = new RegExp(`^(?:${alternatives.map(alternativeSource).join('|')})$`)
    return { ok: true, test: (path) => regex.test(path) }
  } catch {
    return { ok: false, error: 'the pattern is not a valid glob' }
  }
}
