/**
 * Lexical POSIX path helpers and a gitignore-style matcher. Pure string logic: nothing here
 * touches a file system, reads the environment or imports a Node built-in (spec 18 §5).
 */

/** Normalise a POSIX path lexically: collapse `//`, `.` and `..` (an absolute path stops at `/`). */
export function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/** True for a path that starts with `/`. */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

/** Join and normalise path parts. */
export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== '').join('/'))
}

/** Resolve `path` against the absolute directory `base` (an absolute `path` wins). */
export function resolve(base: string, path: string): string {
  return path.startsWith('/') ? normalize(path) : normalize(`${base}/${path}`)
}

/** The path of `to` relative to `from` (both absolute and normalised). */
export function relative(from: string, to: string): string {
  const a = normalize(from).split('/').filter(Boolean)
  const b = normalize(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...Array<string>(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

/** True when `path` is `dir` or below it (absolute, normalised paths). */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../'))
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── gitignore-style matching ────────────────────────────────────────────────────────────────

/** A compiled gitignore pattern. */
export interface IgnorePattern {
  /** A trailing `/`: only directories (here: parents of the tested path) match. */
  dirOnly: boolean
  regex: RegExp
}

/** Translate the glob part of a gitignore pattern (no leading or trailing `/`) to a RegExp source. */
function globSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        let j = i
        while (glob[j + 1] === '*') j++
        const before = i === 0 || glob[i - 1] === '/'
        const after = j + 1 === glob.length || glob[j + 1] === '/'
        if (before && after) {
          if (j + 1 === glob.length) {
            out += '.*'
          } else {
            out += '(?:.*/)?'
            j++ // the following slash is part of the group
          }
          i = j
          continue
        }
        i = j
      }
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) {
        out += '\\['
      } else {
        let body = glob.slice(i + 1, end)
        let negate = false
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = true
          body = body.slice(1)
        }
        out += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        i = end
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      out += escapeRegExp(glob[++i] as string)
    } else {
      out += escapeRegExp(ch)
    }
  }
  return out
}

/**
 * Compile one gitignore pattern. Returns `undefined` for a blank pattern, a comment (`#`) and a
 * negation (`!`): rules never un-match.
 *
 * - a pattern without a `/` (except a trailing one) matches at any depth;
 * - a pattern with a `/` is anchored at the base directory (a leading `/` is dropped);
 * - a trailing `/` matches directories only; `**` matches any number of directories;
 * - `*` and `?` never match a `/` and, unlike a shell, do match a leading dot.
 */
export function compilePattern(pattern: string): IgnorePattern | undefined {
  let p = pattern.replace(/(?<!\\)\s+$/, '')
  if (p === '' || p.startsWith('#') || p.startsWith('!')) return undefined
  if (p.startsWith('\\#') || p.startsWith('\\!')) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  p = p.replace(/\/+$/, '')
  if (p === '') return undefined
  const anchored = p.includes('/')
  p = p.replace(/^\/+/, '')
  const body = globSource(p)
  try {
    return { dirOnly, regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) }
  } catch {
    return undefined
  }
}

/**
 * Whether a relative path is matched by the pattern: the path itself or any of its parent
 * directories (matching a directory covers everything below it).
 */
export function patternMatches(compiled: IgnorePattern, relPath: string): boolean {
  const segments = relPath.split('/').filter((s) => s !== '')
  const last = compiled.dirOnly ? segments.length - 1 : segments.length
  for (let i = 1; i <= last; i++) {
    if (compiled.regex.test(segments.slice(0, i).join('/'))) return true
  }
  return false
}

const cache = new Map<string, IgnorePattern | null>()

/** Compile with a cache (rules are matched on every call). */
export function cachedPattern(pattern: string): IgnorePattern | undefined {
  let compiled = cache.get(pattern)
  if (compiled === undefined) {
    compiled = compilePattern(pattern) ?? null
    if (cache.size > 2000) cache.clear()
    cache.set(pattern, compiled)
  }
  return compiled ?? undefined
}

/** A matcher for a list of gitignore patterns (a path matches when any pattern does). */
export function ignoreMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const compiled = patterns.map(cachedPattern).filter((c): c is IgnorePattern => c !== undefined)
  return (relPath) => compiled.some((c) => patternMatches(c, relPath))
}
