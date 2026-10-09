/** `/context`: the context window as a grid of 1% cells, plus the numbers behind it. */
import { Box, Text, useWindowSize } from 'ink'
import type { ReactElement } from 'react'
import type { CoderController, ContextCategory, ContextDetails } from '../../contracts.ts'
import { color } from '../theme.ts'
import { fmtAgo, fmtPct, fmtTokens, shortModel } from './format.ts'
import { Loading, Page, Section } from './Page.tsx'
import { useAsync } from './useAsync.ts'

/** Kind of one grid cell. */
export type CellKind = ContextCategory['key'] | 'free' | 'buffer'

const ORDER: ContextCategory['key'][] = ['system', 'memory', 'skills', 'tools', 'mcp', 'messages']

const CELL_COLOR: Record<CellKind, string | undefined> = {
  system: '#6CA6F0',
  memory: '#AF87FF',
  skills: '#FFC107',
  tools: '#48968C',
  mcp: '#4EBA65',
  messages: '#D97757',
  free: color.dim,
  buffer: color.dim,
}

const CELL_SYMBOL: Record<CellKind, string> = {
  system: '⛁',
  memory: '⛁',
  skills: '⛁',
  tools: '⛁',
  mcp: '⛁',
  messages: '⛁',
  free: '⛶',
  buffer: '⛝',
}

/** Tokens of the free space: what is left of the window after usage and the autocompact buffer. */
export function freeTokens(d: ContextDetails): number {
  return Math.max(0, d.window - d.used - bufferTokens(d))
}

/** Tokens of the autocompact buffer that are not already used. */
export function bufferTokens(d: ContextDetails): number {
  return Math.max(0, Math.min(d.autocompactBuffer, d.window - d.used))
}

/**
 * Split `total` cells (each 1% of the window) over the categories, the free space and the
 * autocompact buffer with the largest-remainder method, in display order: categories, free
 * space, buffer.
 */
export function allocateCells(d: ContextDetails, total = 100): CellKind[] {
  const slices: Array<{ kind: CellKind; tokens: number }> = [
    ...ORDER.map((key) => ({
      kind: key as CellKind,
      tokens: d.categories.find((c) => c.key === key)?.tokens ?? 0,
    })),
    { kind: 'free', tokens: freeTokens(d) },
    { kind: 'buffer', tokens: bufferTokens(d) },
  ]
  const sum = slices.reduce((n, s) => n + s.tokens, 0)
  if (sum <= 0) return Array.from({ length: total }, () => 'free' as CellKind)
  const shares = slices.map((s) => {
    const exact = (s.tokens / sum) * total
    return { kind: s.kind, cells: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = total - shares.reduce((n, s) => n + s.cells, 0)
  for (const s of [...shares].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break
    if (s.rest > 0) {
      s.cells++
      left--
    }
  }
  return shares.flatMap((s) => Array.from({ length: s.cells }, () => s.kind))
}

function Grid({ cells, perRow }: { cells: CellKind[]; perRow: number }): ReactElement {
  const rows: CellKind[][] = []
  for (let i = 0; i < cells.length; i += perRow) rows.push(cells.slice(i, i + perRow))
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid rows
        <Text key={r}>
          {groupRuns(row).map((run, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed runs of a fixed row
            <Text key={i} color={CELL_COLOR[run.kind]} dimColor={run.kind === 'free'}>
              {`${CELL_SYMBOL[run.kind]} `.repeat(run.count)}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function groupRuns(row: CellKind[]): Array<{ kind: CellKind; count: number }> {
  const runs: Array<{ kind: CellKind; count: number }> = []
  for (const kind of row) {
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.count++
    else runs.push({ kind, count: 1 })
  }
  return runs
}

function Legend({ d }: { d: ContextDetails }): ReactElement {
  const line = (kind: CellKind, label: string, tokens: number, suffix: string): ReactElement => (
    <Text key={kind} wrap="truncate-end">
      <Text color={CELL_COLOR[kind]} dimColor={kind === 'free'}>
        {CELL_SYMBOL[kind]}
      </Text>{' '}
      {label}: {fmtTokens(tokens)}
      {suffix} <Text dimColor>({fmtPct(tokens, d.window)})</Text>
    </Text>
  )
  return (
    <Box flexDirection="column">
      {ORDER.map((key) => {
        const category = d.categories.find((c) => c.key === key)
        return category ? line(key, category.label, category.tokens, ' tokens') : null
      })}
      {line('free', 'Free space', freeTokens(d), '')}
      {line('buffer', 'Autocompact buffer', bufferTokens(d), '')}
    </Box>
  )
}

function Row({
  cols,
}: {
  cols: Array<{ text: string; width?: number; dim?: boolean; right?: boolean }>
}): ReactElement {
  return (
    <Box>
      {cols.map((c) => (
        <Box
          key={`${c.width ?? 'rest'}:${c.text}`}
          width={c.width}
          flexGrow={c.width ? 0 : 1}
          justifyContent={c.right ? 'flex-end' : 'flex-start'}
        >
          <Text dimColor={c.dim} wrap="truncate-end">
            {c.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

const TOOL_ROWS = 14

/** The body of the page, for tests and for {@link ContextPage}. */
export function ContextBody({
  d,
  now = Date.now(),
  columns,
}: {
  d: ContextDetails
  now?: number
  columns: number
}): ReactElement {
  const cells = allocateCells(d)
  const perRow = columns >= 110 ? 20 : 10
  const wide = columns >= 70
  const grid = <Grid cells={cells} perRow={perRow} />
  const sortedTools = [...d.tools].sort((a, b) => b.tokens - a.tokens)
  const deferredTools = d.tools.filter((t) => t.deferred === true)
  const deferredTokens = deferredTools.reduce((sum, t) => sum + t.tokens, 0)
  return (
    <>
      <Box flexDirection="column">
        <Text>
          <Text bold>Context Usage</Text>
          <Text dimColor>
            {'  '}
            {shortModel(d.model)} · {fmtTokens(d.used)}/{fmtTokens(d.window)} tokens (
            {fmtPct(d.used, d.window)})
          </Text>
        </Text>
        <Box marginTop={1} flexDirection={wide ? 'row' : 'column'}>
          {grid}
          <Box marginLeft={wide ? 3 : 0} marginTop={wide ? 0 : 1}>
            <Legend d={d} />
          </Box>
        </Box>
      </Box>

      <Section title={`Tools (${d.tools.length})`}>
        {sortedTools.length === 0 ? <Text dimColor>(none)</Text> : null}
        {sortedTools.slice(0, TOOL_ROWS).map((t) => (
          <Row
            key={`${t.source}:${t.name}`}
            cols={[
              { text: t.name, width: 30, dim: t.deferred === true },
              {
                text: t.deferred === true ? `${t.source} deferred` : t.source,
                width: 18,
                dim: true,
              },
              { text: fmtTokens(t.tokens), width: 8, right: true },
            ]}
          />
        ))}
        {sortedTools.length > TOOL_ROWS ? (
          <Text dimColor>… {sortedTools.length - TOOL_ROWS} more</Text>
        ) : null}
        {deferredTools.length > 0 ? (
          <Text dimColor>
            {deferredTools.length} deferred (loaded with tool_search) · ~{fmtTokens(deferredTokens)}{' '}
            tokens not sent
          </Text>
        ) : null}
      </Section>

      <Section title="Memory files">
        {d.memoryFiles.length === 0 ? <Text dimColor>(none)</Text> : null}
        {d.memoryFiles.map((f) => (
          <Row
            key={f.path}
            cols={[{ text: f.path }, { text: fmtTokens(f.tokens), width: 8, right: true }]}
          />
        ))}
      </Section>

      <Section title="Messages">
        <Text>
          {d.messages.count} <Text dimColor>messages ·</Text> {d.messages.user}{' '}
          <Text dimColor>user ·</Text> {d.messages.assistant} <Text dimColor>assistant ·</Text>{' '}
          {d.messages.toolCalls} <Text dimColor>tool calls</Text>
        </Text>
      </Section>

      <Section title="Thresholds">
        <Text>
          <Text dimColor>Auto-compact at </Text>
          {fmtTokens(d.summarizeAt)} tokens{' '}
          <Text dimColor>({fmtPct(d.summarizeAt, d.window)})</Text>
        </Text>
        <Text>
          <Text dimColor>Hard limit </Text>
          {fmtTokens(d.hardLimit)} tokens <Text dimColor>({fmtPct(d.hardLimit, d.window)})</Text>
        </Text>
        <Text>
          <Text dimColor>Last compaction </Text>
          {d.lastCompaction
            ? `${fmtTokens(d.lastCompaction.before)} → ${fmtTokens(d.lastCompaction.after)} tokens, ${fmtAgo(d.lastCompaction.at, now)}`
            : 'never'}
        </Text>
        <Text>
          <Text dimColor>Pruned outputs </Text>
          {d.pruned
            ? `${d.pruned.outputs} tool outputs (${fmtTokens(d.pruned.chars)} chars)`
            : 'none'}
        </Text>
      </Section>
    </>
  )
}

/** Props of {@link ContextPage}. */
export interface ContextPageProps {
  controller: CoderController
  onClose(): void
  now?: number
  size?: { rows: number; columns: number }
}

/** The `/context` page. */
export function ContextPage({ controller, onClose, now, size }: ContextPageProps): ReactElement {
  const win = useWindowSize()
  const data = useAsync(() => controller.contextDetails())
  return (
    <Page
      title="Context"
      subtitle="what fills the model's context window"
      onClose={onClose}
      size={size}
    >
      {data.status === 'loading' ? <Loading /> : null}
      {data.status === 'error' ? <Text color={color.error}>{data.message}</Text> : null}
      {data.status === 'ready' ? (
        <ContextBody d={data.data} now={now} columns={size?.columns ?? win.columns} />
      ) : null}
    </Page>
  )
}
