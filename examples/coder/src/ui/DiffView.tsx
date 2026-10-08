import { createTwoFilesPatch } from 'diff'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { keyedLines } from './keys.ts'
import { color } from './theme.ts'

/** Props of {@link DiffView}: either a ready unified `patch`, or `oldText` and `newText`. */
export interface DiffViewProps {
  patch?: string
  oldText?: string
  newText?: string
  path?: string
  /** Lines shown before `… N more lines`. Default 20. */
  maxLines?: number
}

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
      { context: 2 },
    )
  const lines = patch.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return props.patch === undefined ? lines.filter((line) => !isHeader(line)) : lines
}

function lineColor(line: string): string | undefined {
  if (line.startsWith('@@')) return color.hunk
  if (line.startsWith('+') && !line.startsWith('+++')) return color.added
  if (line.startsWith('-') && !line.startsWith('---')) return color.removed
  return undefined
}

/** A colored unified diff. */
export function DiffView(props: DiffViewProps): ReactElement {
  const max = props.maxLines ?? 20
  const lines = diffLinesOf(props)
  const shown = lines.slice(0, max)
  return (
    <Box flexDirection="column">
      {keyedLines(shown).map(({ key, line }) => (
        <Text key={key} color={lineColor(line)} dimColor={lineColor(line) === undefined}>
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {lines.length > max ? <Text dimColor>… {lines.length - max} more lines</Text> : null}
    </Box>
  )
}
