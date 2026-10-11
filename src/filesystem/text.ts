/** Text helpers shared by `inMemoryFs` and the file tools; the grep helpers are exported for adapter authors. */

/**
 * Lines of a text for grep: split on `\n`, a trailing `\r` removed. Use it in a `FileSystem.grep`
 * implementation so line numbers match the file tools.
 */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

export {
  GREP_MAX_PATTERN,
  GREP_PATTERN_RULE,
  GREP_SCAN_CHARS,
  isLiteralPattern,
  statelessPattern,
  unsafePatternReason,
} from '../index.ts'
