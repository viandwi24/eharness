/**
 * A message from another agent in the main chat: a header line, then a markdown preview of the
 * report cut to a few rows with `… +N lines (ctrl+o to expand)` (the whole report when expanded).
 */
import { Box, Text, useWindowSize } from 'ink'
import type { ReactElement } from 'react'
import { Markdown } from './markdown.tsx'
import { sym } from './theme.ts'
import { wrapWords } from './wrap.ts'

/** Rows of the collapsed preview. */
export const PREVIEW_ROWS = 8
/** Columns taken by the `  ⎿ ` gutter. */
const GUTTER = 4

/** The cut of {@link previewText}. */
export interface Preview {
  /** Markdown source of the visible part. */
  text: string
  /** Non-empty source lines that are not shown (0 when only part of the last line was cut). */
  hidden: number
  /** Whether anything was cut. */
  truncated: boolean
}

/**
 * Cut `text` to about `maxRows` terminal rows of `width` columns. Wrapped rows count (one long
 * line can use the whole budget), blank lines count as one row, and a code fence that the cut
 * leaves open is closed again so the preview still renders as markdown.
 */
export function previewText(text: string, width: number, maxRows = PREVIEW_ROWS): Preview {
  const lines = text.replace(/\s+$/, '').split('\n')
  const kept: string[] = []
  let rows = 0
  let at = 0
  let cutInLine = false
  for (; at < lines.length; at++) {
    const line = lines[at] as string
    const need = Math.max(1, wrapWords(line, Math.max(1, width)).length)
    if (rows + need <= maxRows) {
      kept.push(line)
      rows += need
      continue
    }
    // the line does not fit: keep the rows that do (only when it is the first thing shown)
    const room = maxRows - rows
    if (room > 0 && kept.every((l) => l.trim() === '')) {
      const wrapped = wrapWords(line, Math.max(1, width)).slice(0, room)
      kept.push(`${wrapped.join(' ').replace(/\s+$/, '')}${sym.ellipsis}`)
      cutInLine = true
      at++
    }
    break
  }
  const rest = lines.slice(at)
  const hidden = rest.filter((l) => l.trim() !== '').length
  const truncated = cutInLine || hidden > 0
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
  const fences = kept.filter((l) => /^\s*(```|~~~)/.test(l)).length
  if (fences % 2 === 1) kept.push('```')
  return { text: kept.join('\n'), hidden, truncated }
}

/** Props of {@link ReportBlock}. */
export interface ReportBlockProps {
  /** Header line, e.g. `⏺ Message from writer · general-purpose · finished`. */
  head: string
  /** Report text (markdown). */
  body: string
  expanded: boolean
}

/** A report with its header and a collapsed preview. */
export function ReportBlock({ head, body, expanded }: ReportBlockProps): ReactElement {
  const { columns } = useWindowSize()
  const text = body.trim()
  const preview = expanded ? undefined : previewText(text, Math.max(10, columns - GUTTER))
  const shown = preview === undefined ? text : preview.text
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>{head}</Text>
      {shown === '' ? null : (
        <Box>
          <Box flexShrink={0} width={GUTTER}>
            <Text dimColor>
              {'  '}
              {sym.branch}{' '}
            </Text>
          </Box>
          <Markdown text={shown} />
        </Box>
      )}
      {preview?.truncated ? (
        <Text dimColor>
          {'    '}
          {sym.ellipsis}
          {preview.hidden > 0 ? ` +${preview.hidden} lines` : ''} (ctrl+o to expand)
        </Text>
      ) : null}
    </Box>
  )
}
