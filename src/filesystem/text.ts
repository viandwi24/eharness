/** Text helpers shared by `memoryFs` and the file tools (internal to `src/filesystem`). */

/** Lines of a text for grep: split on `\n`, a trailing `\r` removed. */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Longest accepted `grep` pattern (characters). */
export const GREP_MAX_PATTERN = 512
/**
 * Characters of one line a pattern is matched against (the rest of a longer line is ignored):
 * keeps the worst case of an accepted pattern (one quantifier, quadratic) at a few ms per line.
 */
export const GREP_SCAN_CHARS = 2_000
/** A `{n,m}` range with a larger upper bound counts as unbounded. */
const LARGE_RANGE = 100

/** True when `pattern` has no regular expression metacharacters (a literal search). */
export function isLiteralPattern(pattern: string): boolean {
  return !/[\\^$.|?*+()[\]{}]/.test(pattern)
}

type Quantifier = { length: number; repeats: boolean; unbounded: boolean }

/**
 * Why `source` is refused as a `grep` pattern (spec 08 §3), or `undefined` when it is accepted.
 * A **conservative safe subset** of JavaScript regular expressions, not a proof of linear time:
 *
 * - at most {@link GREP_MAX_PATTERN} characters;
 * - no backreferences, no lookaround assertions;
 * - at most **one** unbounded quantifier (`*`, `+`, `{n,}`, `{n,m}` with m > 100) in the whole
 *   pattern (`\w*\w*x`, `.*foo.*bar` are refused);
 * - no repeated group that contains a repeating quantifier (`(a+)+`, `(\d+\.)+\d+`) or an
 *   alternation (`(a|a)*b`, `(foo|bar)+`).
 *
 * With one quantifier a match attempt is at worst quadratic in the line length, which
 * {@link GREP_SCAN_CHARS} bounds. Adapters that push `grep` down should run a linear-time engine
 * (RE2) or apply the same limits.
 */
export function unsafePatternReason(source: string): string | undefined {
  if (source.length > GREP_MAX_PATTERN) return `longer than ${GREP_MAX_PATTERN} characters`
  /** Open groups: does their content repeat / contain an alternation? */
  const groups: Array<{ repeats: boolean; alternation: boolean }> = []
  /** The group that just closed (a quantifier may follow it). */
  let closed: { repeats: boolean; alternation: boolean } | undefined
  let unbounded = 0
  const quantifier = (at: number): Quantifier => {
    const c = source[at]
    if (c === '*' || c === '+') return { length: 1, repeats: true, unbounded: true }
    if (c === '?') return { length: 1, repeats: false, unbounded: false }
    if (c !== '{') return { length: 0, repeats: false, unbounded: false }
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at))
    if (m === null) return { length: 0, repeats: false, unbounded: false }
    const max =
      m[2] === undefined ? Number(m[1]) : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3])
    return { length: m[0].length, repeats: max > 1, unbounded: max > LARGE_RANGE }
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const q = quantifier(i)
    if (q.length > 0) {
      if (q.repeats && closed !== undefined) {
        if (closed.repeats) return 'a repeated group contains a repeating quantifier'
        if (closed.alternation) return 'a repeated group contains an alternation'
      }
      if (q.unbounded) {
        unbounded++
        if (unbounded > 1) return 'more than one unbounded quantifier'
      }
      const top = groups.at(-1)
      if (q.repeats && top !== undefined) top.repeats = true
      closed = undefined
      i += q.length - 1
      // a lazy suffix (`*?`) belongs to the quantifier
      if (q.repeats && source[i + 1] === '?') i++
      continue
    }
    closed = undefined
    if (c === '\\') {
      const next = source[i + 1] ?? ''
      if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) {
        return 'backreferences are not supported'
      }
      i++
      continue
    }
    if (c === '[') {
      // a character class is one atom: skip to its closing bracket
      let j = i + 1
      if (source[j] === '^') j++
      if (source[j] === ']') j++
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '(') {
      if (/^\(\?(=|!|<=|<!)/.test(source.slice(i))) return 'lookaround assertions are not supported'
      groups.push({ repeats: false, alternation: false })
      continue
    }
    if (c === ')') {
      const group = groups.pop()
      if (group === undefined) continue
      const parent = groups.at(-1)
      if (parent !== undefined) {
        parent.repeats ||= group.repeats
        parent.alternation ||= group.alternation
      }
      closed = group
      continue
    }
    if (c === '|') {
      const top = groups.at(-1)
      if (top !== undefined) top.alternation = true
    }
  }
  return undefined
}

/** A copy of `pattern` without the stateful `g` / `y` flags (so `test` has no `lastIndex`). */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
}
