import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { TOOL } from '../contracts.ts'
import { DiffView } from './DiffView.tsx'
import { keyedLines } from './keys.ts'
import { SubagentTree } from './SubagentTree.tsx'
import { color, sym } from './theme.ts'
import {
  describeTool,
  displayPath,
  firstLine,
  isAgentProgress,
  type ToolContext,
  type ToolStatus,
  type ToolView,
} from './tool-summary.ts'

/** Props of {@link ToolCard}. */
export interface ToolCardProps {
  view: ToolView
  context: ToolContext
  expanded: boolean
}

const STATUS_COLOR: Record<ToolStatus, string> = {
  running: color.running,
  waiting: color.running,
  ok: color.ok,
  error: color.error,
  denied: color.denied,
}

function truncateText(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more lines`
}

function pretty(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function Expanded({ view }: { view: ToolView }): ReactElement {
  const input = (view.input ?? {}) as Record<string, unknown>
  const isEdit =
    view.toolName === TOOL.edit &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  const output = view.state === 'output-available' && !view.preliminary ? pretty(view.output) : ''
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      {isEdit ? (
        <DiffView
          oldText={input.old_string as string}
          newText={input.new_string as string}
          path={displayPath(String(input.path ?? ''))}
          maxLines={40}
        />
      ) : (
        <Text dimColor>{truncateText(pretty(view.input), 12)}</Text>
      )}
      {output ? <Text dimColor>{truncateText(output, 24)}</Text> : null}
    </Box>
  )
}

/** One collapsed line per tool call (plus live output, subagent progress, expanded detail). */
export function ToolCard({ view, context, expanded }: ToolCardProps): ReactElement {
  const desc = describeTool(view, context)
  const progress = isAgentProgress(view.output) ? view.output : undefined
  const childResult =
    view.toolName === TOOL.agent && view.state === 'output-available' && !view.preliminary
      ? typeof view.output === 'string'
        ? firstLine(view.output, 140)
        : undefined
      : undefined
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={STATUS_COLOR[desc.status]}>{sym.bullet} </Text>
        <Text bold>{desc.label}</Text>
        <Text> {desc.target}</Text>
        {desc.suffix ? <Text dimColor> {desc.suffix}</Text> : null}
      </Text>
      {keyedLines(desc.tail ?? []).map(({ key, line }) => (
        <Text key={key} dimColor wrap="truncate-end">
          {'  '}
          {sym.branch} {line}
        </Text>
      ))}
      {desc.error ? (
        <Text color={color.error} wrap="truncate-end">
          {'  '}
          {sym.branch} {desc.error}
        </Text>
      ) : null}
      {view.toolName === TOOL.agent && progress && view.state === 'output-available' ? (
        <SubagentTree progress={progress} />
      ) : null}
      {childResult ? (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {sym.branch} {childResult}
        </Text>
      ) : null}
      {expanded ? <Expanded view={view} /> : null}
    </Box>
  )
}
