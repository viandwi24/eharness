/** Text helpers shared by `memoryFs` and the file tools (internal to `src/filesystem`). */

/** Lines of a text for grep: split on `\n`, a trailing `\r` removed. */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** A copy of `pattern` without the stateful `g` / `y` flags (so `test` has no `lastIndex`). */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
}
