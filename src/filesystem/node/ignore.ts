/**
 * Ignore rules of `diskFs`: `.git/` and `node_modules/` always, plus a small subset of the root
 * `.gitignore` syntax and the caller's extra patterns. Rules only hide paths from `list`, `grep`
 * and `glob`; explicit reads and writes still work.
 *
 * Supported subset (spec 08 §8): blank lines and `#` comments; `!` negation (last match wins);
 * a trailing slash (directories only); a leading or inner slash (anchored to the root, otherwise
 * the pattern matches at any depth); `*`, `?`, `[abc]`, `[!abc]`, `[a-z]`; a double-star segment
 * (leading, trailing or between slashes); `\#` and `\!` escapes. A file below an
 * ignored directory is ignored and cannot be re-included (as in git). Not supported: nested `.gitignore` files,
 * `.git/info/exclude`, the global excludes file, case-insensitive matching.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Decides which paths are hidden from listings. */
export interface IgnoreRules {
  /** `relPath` is relative to the root with `/` separators; `isDir` marks a directory. */
  isHidden(relPath: string, isDir: boolean): boolean
}

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])

interface Pattern {
  negate: boolean
  dirOnly: boolean
  regex: RegExp
}

const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

function segmentSource(segment: string): string {
  let out = ''
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

function parseLine(raw: string): Pattern | undefined {
  let line = raw.replace(/\r$/, '')
  // trailing spaces are dropped unless escaped
  line = line.replace(/(?<!\\)\s+$/, '')
  if (line === '' || line.startsWith('#')) return undefined
  let negate = false
  if (line.startsWith('!')) {
    negate = true
    line = line.slice(1)
  }
  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.replace(/\/+$/, '')
  }
  if (line === '') return undefined
  const anchored = line.includes('/')
  line = line.replace(/^\/+/, '')
  const segments = line.split('/').filter((s) => s !== '')
  if (segments.length === 0) return undefined
  const parts: string[] = []
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      if (last) parts.push('.*')
      else parts.push('(?:.*/)?')
    } else {
      parts.push(segmentSource(segment) + (last ? '' : '/'))
    }
  })
  const body = parts.join('')
  try {
    return { negate, dirOnly, regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`) }
  } catch {
    return undefined
  }
}

/**
 * Ignore rules from pattern lines (the same syntax and subset as a `.gitignore`).
 *
 * @param lines Pattern lines, in order (later lines win).
 */
export function compileIgnore(lines: readonly string[]): IgnoreRules {
  const patterns = lines.map(parseLine).filter((p): p is Pattern => p !== undefined)
  const ignoredByPatterns = (rel: string, isDir: boolean): boolean => {
    let ignored = false
    for (const p of patterns) {
      if (p.dirOnly && !isDir) continue
      if (p.negate ? ignored : !ignored) {
        if (p.regex.test(rel)) ignored = !p.negate
      }
    }
    return ignored
  }
  return {
    isHidden(relPath, isDir) {
      const rel = relPath.replace(/^\/+/, '').replace(/\/+$/, '')
      if (rel === '' || rel.startsWith('../')) return false
      const segments = rel.split('/')
      if (segments.some((segment) => ALWAYS_HIDDEN.has(segment))) return true
      for (let i = 1; i <= segments.length; i++) {
        const last = i === segments.length
        if (ignoredByPatterns(segments.slice(0, i).join('/'), last ? isDir : true)) return true
      }
      return false
    },
  }
}

/**
 * Ignore rules of a root: `.git/` and `node_modules/` always, the root `.gitignore` when
 * `gitignore` is not `false` (read now), then the `hidden` patterns.
 *
 * @param root Real absolute directory.
 */
export async function loadIgnoreRules(
  root: string,
  opts: { gitignore?: boolean; hidden?: readonly string[] } = {},
): Promise<IgnoreRules> {
  const lines: string[] = []
  if (opts.gitignore !== false) {
    try {
      lines.push(...(await readFile(join(root, '.gitignore'), 'utf8')).split('\n'))
    } catch {
      // no .gitignore
    }
  }
  lines.push(...(opts.hidden ?? []))
  return compileIgnore(lines)
}
