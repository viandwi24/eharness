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
  | { kind: 'add'; line: number; text: string }
  | { kind: 'remove'; line: number; text: string }
  | { kind: 'context'; line: number; text: string }
  | { kind: 'gap' }
  | { kind: 'note'; text: string }
  | { kind: 'header'; text: string }

function patchText(props: DiffViewProps): string {
  return (
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
  )
}

interface FileMeta {
  row: { kind: 'header'; text: string }
  path: string
  tags: string[]
}

function refreshHeader(meta: FileMeta): void {
  meta.row.text = [meta.path, ...meta.tags].join(' · ')
}

/**
 * Parses a unified diff (plain hunks, or a full `git diff` with extended headers) into rows.
 * Header lines are only recognised outside hunks; hunk bodies are consumed by the counts of
 * their `@@` header, so a removed line like `-- x` is never mistaken for a `--- ` header.
 * Line numbers come from the hunk headers; git extended headers become one dim header row.
 */
export function diffRows(props: DiffViewProps): DiffRow[] {
  const lines = patchText(props).split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rows: DiffRow[] = []
  let meta: FileMeta | undefined
  let hunksInFile = 0
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  const tag = (t: string): void => {
    if (!meta) return
    meta.tags.push(t)
    refreshHeader(meta)
  }
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0 || (line.startsWith('\\') && hunksInFile > 0)) {
      if (line.startsWith('\\')) {
        rows.push({ kind: 'note', text: line.replace(/^\\ ?/, '') })
      } else if (line.startsWith('+')) {
        rows.push({ kind: 'add', line: newNo++, text: line.slice(1) })
        newLeft--
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'remove', line: oldNo++, text: line.slice(1) })
        oldLeft--
      } else {
        rows.push({ kind: 'context', line: newNo++, text: line.slice(1) })
        oldNo++
        oldLeft--
        newLeft--
      }
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (hunksInFile > 0) rows.push({ kind: 'gap' })
      hunksInFile++
      continue
    }
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
    if (git) {
      const row = { kind: 'header' as const, text: '' }
      meta = { row, path: git[2] ?? git[1] ?? '', tags: [] }
      refreshHeader(meta)
      rows.push(row)
      hunksInFile = 0
      continue
    }
    if (!meta) continue
    if (line.startsWith('new file mode')) tag('new file')
    else if (line.startsWith('deleted file mode')) tag('deleted')
    else if (line.startsWith('rename from ')) tag(`renamed from ${line.slice(12)}`)
    else if (line.startsWith('copy from ')) tag(`copied from ${line.slice(10)}`)
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) tag('binary')
    else if (line.startsWith('new mode ')) tag(`mode ${line.slice(9)}`)
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
  if (row.kind === 'gap') return <Text dimColor>{' '.repeat(width + 1)}⋯</Text>
  if (row.kind === 'header' || row.kind === 'note')
    return (
      <Text dimColor>
        {row.kind === 'note' ? ' '.repeat(width + 3) : ''}
        {row.text}
      </Text>
    )
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
  const width = Math.max(2, ...shown.map((row) => ('line' in row ? String(row.line).length : 0)))
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
