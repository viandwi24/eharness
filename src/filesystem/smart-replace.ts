/**
 * The smart replace cascade of `edit_file` (spec 08 §4): exact match → line-trimmed match →
 * whitespace-normalized match. Never guesses: more than one match without `replace_all` is an
 * error the model can read.
 *
 * @see docs/specs/08-filesystem-plugin.md#4-editing-rules-from-the-predecessor-harness-proven-in-production
 */

/** Which cascade level matched. */
export type ReplaceStrategy = 'exact' | 'line-trimmed' | 'whitespace-normalized'

/** Result of {@link smartReplace}. `error` is model-readable text without the `ERROR:` prefix. */
export type SmartReplaceResult =
  | { ok: true; content: string; count: number; strategy: ReplaceStrategy }
  | { ok: false; error: string }

/** A match as a half-open range `[start, end)` of the original content. */
interface Range {
  start: number
  end: number
}

function exactRanges(content: string, needle: string): Range[] {
  const ranges: Range[] = []
  let from = 0
  for (;;) {
    const index = content.indexOf(needle, from)
    if (index === -1) return ranges
    ranges.push({ start: index, end: index + needle.length })
    from = index + needle.length
  }
}

/** Line starts and ends (end excludes the `\n`, and a trailing `\r`). */
function lineSpans(content: string): Range[] {
  const spans: Range[] = []
  let start = 0
  for (;;) {
    const newline = content.indexOf('\n', start)
    const end = newline === -1 ? content.length : newline
    spans.push({ start, end: end > start && content[end - 1] === '\r' ? end - 1 : end })
    if (newline === -1) return spans
    start = newline + 1
  }
}

/**
 * Windows of whole lines whose trimmed text equals the trimmed needle lines. The range ends before
 * the last line's trailing whitespace; it starts at the line start when the needle's first line is
 * indented (the replacement carries its own indentation), otherwise after the file's indentation.
 */
function lineTrimmedRanges(content: string, needle: string): Range[] {
  const wanted = needle.replace(/\r\n/g, '\n').split('\n')
  while (wanted.length > 0 && wanted[0]?.trim() === '') wanted.shift()
  while (wanted.length > 0 && wanted.at(-1)?.trim() === '') wanted.pop()
  if (wanted.length === 0) return []
  const trimmed = wanted.map((line) => line.trim())
  // a needle that carries its own indentation replaces whole lines (new_string brings its own)
  const indented = /^\s/.test(wanted[0] as string)
  const spans = lineSpans(content)
  const texts = spans.map((span) => content.slice(span.start, span.end).trim())
  const ranges: Range[] = []
  for (let i = 0; i + trimmed.length <= spans.length; ) {
    if (trimmed.every((line, j) => texts[i + j] === line)) {
      // keep trailing whitespace of the last line; keep the first line's indentation only
      // when the needle has none
      const first = spans[i] as Range
      const last = spans[i + trimmed.length - 1] as Range
      const firstText = content.slice(first.start, first.end)
      const lastText = content.slice(last.start, last.end)
      ranges.push({
        start: indented
          ? first.start
          : first.start + (firstText.length - firstText.trimStart().length),
        end: last.end - (lastText.length - lastText.trimEnd().length),
      })
      i += trimmed.length
    } else {
      i++
    }
  }
  return ranges
}

/** Matches after collapsing every whitespace run to one space (both sides trimmed). */
function whitespaceRanges(content: string, needle: string): Range[] {
  const target = needle.trim().replace(/\s+/g, ' ')
  if (target === '') return []
  // normalized text + for each normalized char the original range it stands for
  let normalized = ''
  const origin: Range[] = []
  for (let i = 0; i < content.length; ) {
    if (/\s/.test(content[i] as string)) {
      let j = i
      while (j < content.length && /\s/.test(content[j] as string)) j++
      normalized += ' '
      origin.push({ start: i, end: j })
      i = j
    } else {
      normalized += content[i]
      origin.push({ start: i, end: i + 1 })
      i++
    }
  }
  return exactRanges(normalized, target).map((range) => ({
    start: (origin[range.start] as Range).start,
    end: (origin[range.end - 1] as Range).end,
  }))
}

function apply(content: string, ranges: Range[], replacement: string): string {
  let out = ''
  let at = 0
  for (const range of ranges) {
    out += content.slice(at, range.start) + replacement
    at = range.end
  }
  return out + content.slice(at)
}

const LEVELS: Array<[ReplaceStrategy, (content: string, needle: string) => Range[]]> = [
  ['exact', exactRanges],
  ['line-trimmed', lineTrimmedRanges],
  ['whitespace-normalized', whitespaceRanges],
]

/**
 * Replace `oldString` with `newString` in `content` using the cascade exact → line-trimmed
 * (whole lines compared with surrounding whitespace ignored) → whitespace-normalized (every
 * whitespace run counts as one space). The first level with a match decides; more than one
 * match at that level without `replaceAll` is an error. `newString` is inserted verbatim.
 */
export function smartReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): SmartReplaceResult {
  if (oldString === '') {
    return { ok: false, error: 'old_string must not be empty (use write_file to create a file)' }
  }
  if (oldString === newString) {
    return { ok: false, error: 'old_string and new_string are identical; nothing to change' }
  }
  for (const [strategy, find] of LEVELS) {
    const ranges = find(content, oldString)
    if (ranges.length === 0) continue
    if (ranges.length > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${ranges.length} places; add surrounding lines to make it unique, or set replace_all to change every match`,
      }
    }
    return { ok: true, content: apply(content, ranges, newString), count: ranges.length, strategy }
  }
  return {
    ok: false,
    error:
      'old_string was not found (compared exactly, per trimmed line and with whitespace collapsed); read the file again and copy the text exactly',
  }
}
