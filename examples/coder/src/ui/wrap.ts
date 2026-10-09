/**
 * Word wrapping and visual rows. Used by the prompt editor (it needs the exact rows to place the
 * cursor and to move between them) and by anything that wraps styled runs itself. Lines break at
 * spaces; only a word wider than the row is split. Widths are terminal cells: East-Asian wide
 * characters and emoji take two, combining marks and joiners none.
 */

/** Terminal cells taken by one code point. */
export function cellWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Terminal cells taken by a string (no ANSI; use on plain text). */
export function stringWidth(text: string): number {
  let width = 0
  for (const ch of text) width += cellWidth(ch.codePointAt(0) ?? 0)
  return width
}

/** A half-open range of a string, in UTF-16 code units. */
export interface Range {
  start: number
  end: number
}

const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t'

/**
 * Rows of ONE logical line (no `\n`). The ranges tile the line exactly: the spaces after a word
 * stay at the end of its row (they may be trimmed for display), and a word that does not fit moves
 * whole to the next row. A word wider than `width` is split by characters. An empty line is one
 * empty range.
 */
export function wrapRanges(line: string, width: number): Range[] {
  const limit = Math.max(1, Math.floor(width))
  const ranges: Range[] = []
  let rowStart = 0
  let rowWidth = 0
  let at = 0
  const breakAt = (index: number): void => {
    ranges.push({ start: rowStart, end: index })
    rowStart = index
    rowWidth = 0
  }
  while (at < line.length) {
    const first = line.charAt(at)
    let end = at
    const blank = isBlank(first)
    let tokenWidth = 0
    while (end < line.length && isBlank(line.charAt(end)) === blank) {
      const cp = line.codePointAt(end) ?? 0
      tokenWidth += cellWidth(cp)
      end += cp > 0xffff ? 2 : 1
    }
    if (!blank && rowWidth + tokenWidth > limit && rowWidth > 0) breakAt(at)
    if (!blank && tokenWidth <= limit - rowWidth) {
      rowWidth += tokenWidth
    } else {
      if (blank && end < line.length && tokenWidth <= limit) {
        // blanks before a word hang at the end of the row (trimmed on display) instead of starting the next one
        rowWidth = Math.min(limit, rowWidth + tokenWidth)
        at = end
        continue
      }
      // a word wider than a whole row, or blanks that end the line: place character by character
      let i = at
      while (i < end) {
        const cp = line.codePointAt(i) ?? 0
        const w = cellWidth(cp)
        if (rowWidth + w > limit && rowWidth > 0) breakAt(i)
        rowWidth += w
        i += cp > 0xffff ? 2 : 1
      }
    }
    at = end
  }
  ranges.push({ start: rowStart, end: line.length })
  return ranges
}

/**
 * Wrap text into rows of at most `width` cells. `\n` always breaks. Trailing spaces of a wrapped
 * row are dropped (the row of the last word keeps none either); leading indentation is kept.
 */
export function wrapWords(text: string, width: number): string[] {
  const rows: string[] = []
  for (const line of text.split('\n')) {
    const ranges = wrapRanges(line, width)
    ranges.forEach((range, i) => {
      const row = line.slice(range.start, range.end).replace(/[ \t]+$/, '')
      if (row === '' && i > 0) return
      rows.push(row)
    })
  }
  return rows
}

/** A styled run; the style fields are whatever the caller attaches. */
export interface Run {
  text: string
}

/**
 * Wrap styled runs (bold, code, ...) into rows of runs. Breaks are decided on the concatenated
 * text, so a word split across two runs is still one word.
 */
export function wrapRuns<T extends Run>(runs: readonly T[], width: number): T[][] {
  const text = runs.map((run) => run.text).join('')
  const rows: T[][] = []
  let offset = 0
  for (const line of text.split('\n')) {
    for (const range of wrapRanges(line, width)) {
      const from = offset + range.start
      const to = offset + range.end
      const row: T[] = []
      let cursor = 0
      for (const run of runs) {
        const s = Math.max(from, cursor)
        const e = Math.min(to, cursor + run.text.length)
        if (e > s) row.push({ ...run, text: run.text.slice(s - cursor, e - cursor) })
        cursor += run.text.length
      }
      const last = row[row.length - 1]
      if (last) {
        const trimmed = last.text.replace(/[ \t]+$/, '')
        if (trimmed === '') row.pop()
        else last.text = trimmed
      }
      rows.push(row)
    }
    offset += line.length + 1
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// Visual rows of the prompt buffer
// ---------------------------------------------------------------------------------------------

/** One visual row of the prompt: `text.slice(start, end)`, `soft` when it continues on the next row. */
export interface VisualRow extends Range {
  soft: boolean
}

/** Visual rows of a whole buffer text at `width` cells (hard newlines and soft wraps). */
export function visualRows(text: string, width: number): VisualRow[] {
  const rows: VisualRow[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const ranges = wrapRanges(line, width)
    ranges.forEach((range, i) => {
      rows.push({
        start: offset + range.start,
        end: offset + range.end,
        soft: i < ranges.length - 1,
      })
    })
    offset += line.length + 1
  }
  return rows
}

/** Row index and cell column of the cursor. At a soft wrap boundary the cursor belongs to the next row. */
export function cursorPlace(
  text: string,
  rows: readonly VisualRow[],
  cursor: number,
): { row: number; col: number } {
  let row = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as VisualRow
    if (cursor >= r.start && (cursor < r.end || (cursor === r.end && !r.soft))) {
      row = i
      break
    }
  }
  const r = rows[row] as VisualRow
  return { row, col: stringWidth(text.slice(r.start, Math.min(cursor, r.end))) }
}

/** Index in `row` that sits at (or just before) cell column `col`; never past the row's last cursor stop. */
export function indexAtColumn(text: string, row: VisualRow, col: number): number {
  let i = row.start
  let width = 0
  while (i < row.end) {
    const cp = text.codePointAt(i) ?? 0
    const w = cellWidth(cp)
    if (width + w > col) break
    width += w
    i += cp > 0xffff ? 2 : 1
  }
  if (i >= row.end && row.soft && row.end > row.start) {
    // the end of a soft row is the start of the next one: stop on the last character instead
    const low = text.charCodeAt(row.end - 1)
    return row.end - (low >= 0xdc00 && low <= 0xdfff && row.end - 2 >= row.start ? 2 : 1)
  }
  return i
}

/**
 * Cursor index after moving one visual row up (`-1`) or down (`1`) keeping the column, or
 * `undefined` when the cursor is already on the first / last row.
 */
export function moveVisual(
  text: string,
  rows: readonly VisualRow[],
  cursor: number,
  dir: -1 | 1,
  goal?: number,
): number | undefined {
  const { row, col } = cursorPlace(text, rows, cursor)
  const target = rows[row + dir]
  if (!target) return undefined
  return indexAtColumn(text, target, goal ?? col)
}
