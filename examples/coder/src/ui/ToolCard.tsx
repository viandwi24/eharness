import { Box, Text, useAnimation } from 'ink'
import type { ReactElement } from 'react'
import { editsOf } from '../app/edits.ts'
import { TOOL } from '../contracts.ts'
import { Branch, Indent } from './Branch.tsx'
import { DiffView } from './DiffView.tsx'
import { keyedLines } from './keys.ts'
import { SubagentTree } from './SubagentTree.tsx'
import { expandTabs } from './sanitize.ts'
import { TodoList } from './TodoPanel.tsx'
import { color, sym } from './theme.ts'
import {
  bashBody,
  countEditChanges,
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

/** Bullet color of a status (read at render time so theme switches apply). */
export function statusColor(status: ToolStatus): string | undefined {
  switch (status) {
    case 'running':
      return color.dim
    case 'waiting':
      return color.warning
    case 'ok':
      return color.ok
    case 'error':
      return color.error
    case 'denied':
      return color.denied
  }
}

const BASH_LINES = 4
const DIFF_LINES = 16
/** Edits of one multi-edit call whose diff is drawn (the summary counts all of them). */
const MAX_EDIT_DIFFS = 5

function pretty(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** The `⏺` bullet: blinks while the call runs, green / red / yellow otherwise. */
export function StatusBullet({ status }: { status: ToolStatus }): ReactElement {
  const { frame } = useAnimation({ interval: 500, isActive: status === 'running' })
  const hidden = status === 'running' && frame % 2 === 1
  return <Text color={statusColor(status)}>{hidden ? ' ' : sym.bullet}</Text>
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
          {line === '' ? ' ' : expandTabs(line)}
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
      const edits = editsOf(input).slice(0, MAX_EDIT_DIFFS)
      const keys = keyedLines(edits.map((e) => `${e.oldString}\u0000${e.newString}`))
      return (
        <>
          {desc.summary ? (
            <Branch>
              <Text dimColor>{desc.summary}</Text>
            </Branch>
          ) : null}
          {desc.status === 'ok'
            ? edits.map((edit, i) => (
                <Indent key={keys[i]?.key}>
                  <DiffView
                    oldText={edit.oldString}
                    newText={edit.newString}
                    path={displayPath(String(input.path ?? ''))}
                    maxLines={expanded ? 400 : DIFF_LINES}
                  />
                </Indent>
              ))
            : null}
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
 * Focus view: the call on a single line, `⏺ Update(src/a.ts) +3 −1` (diffstat for edits, `exit N`
 * for bash, nothing more for the rest).
 */
export function ToolLine({
  view,
  context,
}: {
  view: ToolView
  context: ToolContext
}): ReactElement {
  const desc = describeTool(view, context)
  const input = (view.input ?? {}) as Record<string, unknown>
  let stat = ''
  if (view.toolName === TOOL.edit && desc.status === 'ok') {
    const { added, removed } = countEditChanges(input)
    stat = [added > 0 ? `+${added}` : '', removed > 0 ? `${sym.minus}${removed}` : '']
      .filter(Boolean)
      .join(' ')
  } else if (view.toolName === TOOL.bash && desc.summary) {
    stat = /^exit \d+/.exec(desc.summary)?.[0] ?? desc.summary
  }
  return (
    <Box>
      <Box flexShrink={0} width={2}>
        <StatusBullet status={desc.status} />
      </Box>
      <Text wrap="truncate-end">
        <Text bold>{desc.label}</Text>
        {desc.target ? `(${desc.target})` : ''}
        {stat ? <Text dimColor> {stat}</Text> : null}
      </Text>
    </Box>
  )
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
