import { createTwoFilesPatch } from 'diff'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { color } from './theme.ts'

/** Props of {@link DiffView}: either a ready unified `patch`, or `oldText` and `newText`. */
export interface DiffViewProps {
  patch?: string
  oldText?: string
  newText?: string
  path?: string
  /** Rows shown before `… +N lines`. Default 16. */
  maxLines?: number
  /** Append `(ctrl+o to expand)` to the truncation line. Default true. */
  expandHint?: boolean
}

/** One row of a rendered diff. */
export type DiffRow =
  | { kind: 'add' | 'remove' | 'context'; line: number; text: string }
  | { kind: 'gap' }

function isHeader(line: string): boolean {
  return (
    line.startsWith('Index: ') ||
    line.startsWith('====') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line === '\\ No newline at end of file'
  )
}

/** Unified diff lines without the file headers. */
export function diffLinesOf(props: DiffViewProps): string[] {
  const patch =
    props.patch ??
    createTwoFilesPatch(
      props.path ?? 'file',
      props.path ?? 'file',
      props.oldText ?? '',
      props.newText ?? '',
      '',
      '',
      { context: 3 },
    )
  const lines = patch.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.filter((line) => !isHeader(line))
}

/** Rows with line numbers (new-file numbers; removals carry their old number); hunks separated by a gap. */
export function diffRows(props: DiffViewProps): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of diffLinesOf(props)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      if (rows.length > 0) rows.push({ kind: 'gap' })
      continue
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', line: newNo++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'remove', line: oldNo++, text: line.slice(1) })
    else {
      rows.push({ kind: 'context', line: newNo, text: line.slice(1) })
      oldNo++
      newNo++
    }
  }
  return rows
}

/** Added and removed line counts of a diff. */
export function diffCounts(props: DiffViewProps): { added: number; removed: number } {
  const rows = diffRows(props)
  return {
    added: rows.filter((r) => r.kind === 'add').length,
    removed: rows.filter((r) => r.kind === 'remove').length,
  }
}

function Row({ row, width }: { row: DiffRow; width: number }): ReactElement {
  if (row.kind === 'gap') return <Text dimColor>{' '.repeat(width + 1)}…</Text>
  const gutter = String(row.line).padStart(width)
  const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '
  const bg =
    row.kind === 'add' ? color.addedBg : row.kind === 'remove' ? color.removedBg : undefined
  const fg = row.kind === 'add' ? color.added : row.kind === 'remove' ? color.removed : undefined
  return (
    <Box backgroundColor={bg}>
      <Box flexShrink={0}>
        <Text color={fg} dimColor={fg === undefined}>
          {gutter} {sign}{' '}
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={fg} dimColor={fg === undefined}>
          {row.text === '' ? ' ' : row.text}
        </Text>
      </Box>
    </Box>
  )
}

/** A unified diff with line numbers, green additions and red removals. */
export function DiffView(props: DiffViewProps): ReactElement {
  const max = props.maxLines ?? 16
  const rows = diffRows(props)
  const shown = rows.slice(0, max)
  const width = Math.max(
    2,
    ...shown.map((row) => (row.kind === 'gap' ? 0 : String(row.line).length)),
  )
  const hidden = rows.length - shown.length
  return (
    <Box flexDirection="column">
      {shown.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows of a static diff
        <Row key={`${i}`} row={row} width={width} />
      ))}
      {hidden > 0 ? (
        <Text dimColor>
          … +{hidden} lines{props.expandHint === false ? '' : ' (ctrl+o to expand)'}
        </Text>
      ) : null}
    </Box>
  )
}
