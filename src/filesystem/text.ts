/** Text helpers shared by `memoryFs` and the file tools (internal to `src/filesystem`). */

/** Lines of a text for grep: split on `\n`, a trailing `\r` removed. */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Longest accepted `grep` pattern (characters). */
export const GREP_MAX_PATTERN = 512
/** Characters of one line a pattern is matched against (the rest of a longer line is ignored). */
export const GREP_SCAN_CHARS = 10_000

/** True when `pattern` has no regular expression metacharacters (a literal search). */
export function isLiteralPattern(pattern: string): boolean {
  return !/[\\^$.|?*+()[\]{}]/.test(pattern)
}

/**
 * Why `source` is refused as a `grep` pattern (spec 08 §3), or `undefined` when it is accepted:
 * longer than {@link GREP_MAX_PATTERN}, a backreference, or a nested quantifier — a quantified
 * group that itself contains a quantifier (`(a+)+`, `(\w+\s?)*`), the shape of catastrophic
 * backtracking. A cheap syntactic check, not a proof: adapters that push `grep` down should run
 * a linear-time engine (RE2) or apply the same limits.
 */
export function unsafePatternReason(source: string): string | undefined {
  if (source.length > GREP_MAX_PATTERN) return `longer than ${GREP_MAX_PATTERN} characters`
  /** Open groups: did their content use a repeating quantifier? */
  const groups: boolean[] = []
  /** The last complete atom was a group whose content repeats. */
  let lastGroupRepeats = false
  const repeating = (at: number): boolean => {
    const c = source[at]
    if (c === '*' || c === '+') return true
    if (c !== '{') return false
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at))
    if (m === null) return false
    if (m[2] === undefined) return Number(m[1]) > 1
    return m[3] === '' || Number(m[3]) > 1
  }
  const markRepeat = () => {
    if (groups.length > 0) groups[groups.length - 1] = true
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[i + 1] ?? ''
      if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) {
        return 'backreferences are not supported'
      }
      i++
      lastGroupRepeats = false
      continue
    }
    if (c === '[') {
      // a character class is one atom: skip to its closing bracket
      let j = i + 1
      if (source[j] === '^') j++
      if (source[j] === ']') j++
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1
      i = j
      lastGroupRepeats = false
      continue
    }
    if (c === '(') {
      groups.push(false)
      lastGroupRepeats = false
      continue
    }
    if (c === ')') {
      lastGroupRepeats = groups.pop() === true
      // a group whose content repeats makes its parent's content repeat too
      if (lastGroupRepeats) markRepeat()
      continue
    }
    if (repeating(i)) {
      if (lastGroupRepeats) return 'nested quantifier (catastrophic backtracking)'
      markRepeat()
      lastGroupRepeats = false
      continue
    }
    lastGroupRepeats = false
  }
  return undefined
}

/** A copy of `pattern` without the stateful `g` / `y` flags (so `test` has no `lastIndex`). */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
}
