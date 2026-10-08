/** Stable React keys for lines of a static list: the text plus its occurrence number. */
export function keyedLines(lines: string[]): Array<{ key: string; line: string }> {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const n = seen.get(line) ?? 0
    seen.set(line, n + 1)
    return { key: `${line}#${n}`, line }
  })
}
