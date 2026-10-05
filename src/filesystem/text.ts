/** Text helpers shared by `memoryFs` and the file tools (internal to `src/filesystem`). */

/** Lines of a text for grep: split on `\n`, a trailing `\r` removed. */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Longest accepted `grep` pattern (characters). */
export const GREP_MAX_PATTERN = 512
/**
 * Characters of one line a pattern is matched against (the rest of a longer line is ignored):
 * keeps the worst case of an accepted pattern (one variable quantifier, quadratic) at a few ms
 * per line.
 */
export const GREP_SCAN_CHARS = 2_000

/** True when `pattern` has no regular expression metacharacters (a literal search). */
export function isLiteralPattern(pattern: string): boolean {
  return !/[\\^$.|?*+()[\]{}]/.test(pattern)
}

/** The quantifier at `at`: its length and whether its width varies (`*`, `+`, `?`, `{n,m}` m > n). */
function quantifierAt(source: string, at: number): { length: number; variable: boolean } {
  const c = source[at]
  let length = 0
  let variable = false
  if (c === '*' || c === '+' || c === '?') {
    length = 1
    variable = true
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at))
    if (m === null) return { length: 0, variable: false }
    length = m[0].length
    variable = m[2] !== undefined && (m[3] === '' || Number(m[3]) > Number(m[1]))
  } else {
    return { length: 0, variable: false }
  }
  // a lazy suffix (`*?`, `{1,3}?`) belongs to the quantifier
  if (source[at + length] === '?') length++
  return { length, variable }
}

/** The refusal text's rule, for the model (spec 08 §3). */
export const GREP_PATTERN_RULE =
  'grep accepts only a safe subset of regular expressions: at most one variable-width quantifier (*, +, ?, {n,m}) in the whole pattern, no quantified groups, no backreferences or lookarounds. Search for a plain literal, or split the search into simpler ones.'

/**
 * Why `source` is refused as a `grep` pattern (spec 08 §3), or `undefined` when it is accepted.
 * The rule (a conservative safe subset, so any accepted pattern is at worst quadratic in the
 * scanned {@link GREP_SCAN_CHARS} characters):
 *
 * - at most {@link GREP_MAX_PATTERN} characters;
 * - at most **one** variable-width quantifier in total: `*`, `+`, `?`, lazy variants, `{n,}`
 *   and `{n,m}` with m > n (a fixed `{n}` on a single atom is fine);
 * - no quantified group: `(…)` / `(?:…)` followed by any quantifier, even a fixed `{n}`;
 * - no backreferences, no lookaround assertions (alternation is allowed — groups cannot repeat).
 *
 * Adapters that push `grep` down should run a linear-time engine (RE2) or apply the same rule.
 */
export function unsafePatternReason(source: string): string | undefined {
  if (source.length > GREP_MAX_PATTERN) return `longer than ${GREP_MAX_PATTERN} characters`
  let variable = 0
  /** The previous atom was a group (a quantifier may not follow it). */
  let afterGroup = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const q = quantifierAt(source, i)
    if (q.length > 0) {
      if (afterGroup) return 'a quantified group'
      if (q.variable) {
        variable++
        if (variable > 1) return 'more than one variable-width quantifier'
      }
      i += q.length - 1
      afterGroup = false
      continue
    }
    afterGroup = false
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
      // skip a group prefix (`?:`, `?<name>`): its `?` is not a quantifier
      const prefix = /^\(\?(:|<[A-Za-z_$][\w$]*>)/.exec(source.slice(i))
      if (prefix !== null) i += prefix[0].length - 1
      continue
    }
    if (c === ')') afterGroup = true
  }
  return undefined
}

/** A copy of `pattern` without the stateful `g` / `y` flags (so `test` has no `lastIndex`). */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
}
