import { Box, Text, useAnimation } from 'ink'
import type { ReactElement } from 'react'
import { TOOL } from '../contracts.ts'
import { Branch, Indent } from './Branch.tsx'
import { DiffView } from './DiffView.tsx'
import { keyedLines } from './keys.ts'
import { SubagentTree } from './SubagentTree.tsx'
import { TodoList } from './TodoPanel.tsx'
import { color, sym } from './theme.ts'
import {
  bashBody,
  describeTool,
  displayPath,
  firstLine,
  isAgentProgress,
  type ToolContext,
  type ToolStatus,
  type ToolView,
  todosOf,
} from './tool-summary.ts'

/** Props of {@link ToolCard}. */
export interface ToolCardProps {
  view: ToolView
  context: ToolContext
  /** Ctrl+O: full input and output instead of the collapsed summary. */
  expanded: boolean
}

const STATUS_COLOR: Record<ToolStatus, string | undefined> = {
  running: color.dim,
  waiting: color.warning,
  ok: color.ok,
  error: color.error,
  denied: color.denied,
}

const BASH_LINES = 4
const DIFF_LINES = 16

function pretty(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** The `⏺` bullet: blinks while the call runs, green / red / yellow otherwise. */
export function StatusBullet({ status }: { status: ToolStatus }): ReactElement {
  const { frame } = useAnimation({ interval: 500, isActive: status === 'running' })
  const hidden = status === 'running' && frame % 2 === 1
  return <Text color={STATUS_COLOR[status]}>{hidden ? ' ' : sym.bullet}</Text>
}

function More({ count, expandHint = true }: { count: number; expandHint?: boolean }): ReactElement {
  return (
    <Text dimColor>
      {sym.ellipsis} +{count} {count === 1 ? 'line' : 'lines'}
      {expandHint ? ' (ctrl+o to expand)' : ''}
    </Text>
  )
}

function Lines({ lines, dim = true }: { lines: string[]; dim?: boolean }): ReactElement {
  return (
    <Box flexDirection="column">
      {keyedLines(lines).map(({ key, line }) => (
        <Text key={key} dimColor={dim}>
          {line === '' ? ' ' : line}
        </Text>
      ))}
    </Box>
  )
}

function Body({
  view,
  context,
  expanded,
}: {
  view: ToolView
  context: ToolContext
  expanded: boolean
}): ReactElement | null {
  const desc = describeTool(view, context)
  const input = (view.input ?? {}) as Record<string, unknown>
  const finished = view.state === 'output-available' && !view.preliminary
  const output = typeof view.output === 'string' ? view.output : pretty(view.output)

  if (desc.error) {
    return (
      <Branch>
        <Text color={desc.status === 'denied' ? color.denied : color.error}>{desc.error}</Text>
      </Branch>
    )
  }

  switch (view.toolName) {
    case TOOL.todo: {
      const todos = todosOf(view.input)
      if (todos.length === 0) return null
      return (
        <Branch>
          <TodoList todos={todos} max={expanded ? 200 : 12} />
        </Branch>
      )
    }
    case TOOL.agent: {
      const progress = isAgentProgress(view.output) ? view.output : undefined
      const result =
        finished && typeof view.output === 'string' ? firstLine(view.output, 140) : undefined
      return (
        <>
          {progress ? <SubagentTree progress={progress} /> : null}
          {result ? (
            <Branch>
              <Text dimColor wrap="truncate-end">
                {result}
              </Text>
            </Branch>
          ) : null}
          {expanded && finished && typeof view.output === 'string' ? (
            <Indent>
              <Lines lines={view.output.split('\n')} />
            </Indent>
          ) : null}
        </>
      )
    }
    case TOOL.ask: {
      if (!finished) return null
      const lines = output.split('\n').filter((line) => line.trim() !== '')
      const dismissed = lines.length === 0 || /dismiss|declin/i.test(lines[0] ?? '')
      const shown = dismissed ? ['Dismissed'] : lines.slice(expanded ? 0 : 1, expanded ? 40 : 12)
      return (
        <Branch>
          <Lines lines={shown.length > 0 ? shown : lines} />
        </Branch>
      )
    }
    case TOOL.bash: {
      const live = desc.tail
      const lines = finished ? bashBody(output) : (live ?? [])
      const shown = expanded ? lines : lines.slice(0, BASH_LINES)
      return (
        <>
          {shown.length > 0 ? (
            <Branch>
              <Lines lines={shown} />
              {lines.length > shown.length ? <More count={lines.length - shown.length} /> : null}
            </Branch>
          ) : null}
          {desc.summary ? (
            shown.length > 0 ? (
              <Indent>
                <Text
                  color={desc.summaryError ? color.error : undefined}
                  dimColor={!desc.summaryError}
                >
                  {desc.summary}
                </Text>
              </Indent>
            ) : (
              <Branch>
                <Text
                  color={desc.summaryError ? color.error : undefined}
                  dimColor={!desc.summaryError}
                >
                  {desc.summary}
                </Text>
              </Branch>
            )
          ) : null}
        </>
      )
    }
    case TOOL.edit: {
      const diffable = typeof input.old_string === 'string' && typeof input.new_string === 'string'
      return (
        <>
          {desc.summary ? (
            <Branch>
              <Text dimColor>{desc.summary}</Text>
            </Branch>
          ) : null}
          {diffable && desc.status === 'ok' ? (
            <Indent>
              <DiffView
                oldText={input.old_string as string}
                newText={input.new_string as string}
                path={displayPath(String(input.path ?? ''))}
                maxLines={expanded ? 400 : DIFF_LINES}
              />
            </Indent>
          ) : null}
        </>
      )
    }
    default: {
      const detail = expanded ? (finished ? output : '') : ''
      return (
        <>
          {desc.summary ? (
            <Branch>
              <Text dimColor wrap="truncate-end">
                {desc.summary}
              </Text>
            </Branch>
          ) : null}
          {expanded ? (
            <Indent>
              <Lines lines={pretty(view.input).split('\n').slice(0, 40)} />
              {detail ? <Lines lines={detail.split('\n').slice(0, 60)} /> : null}
            </Indent>
          ) : null}
        </>
      )
    }
  }
}

/**
 * One tool call: `⏺ Name(args)` and, under it, `⎿  result summary` (diff, output excerpt,
 * checklist or subagent progress depending on the tool).
 */
export function ToolCard({ view, context, expanded }: ToolCardProps): ReactElement {
  const desc = describeTool(view, context)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box flexShrink={0} width={2}>
          <StatusBullet status={desc.status} />
        </Box>
        <Text wrap="truncate-end">
          <Text bold>{desc.label}</Text>
          {desc.target ? `(${desc.target})` : ''}
          {desc.note ? <Text dimColor> {desc.note}</Text> : null}
        </Text>
      </Box>
      <Body view={view} context={context} expanded={expanded} />
    </Box>
  )
}
