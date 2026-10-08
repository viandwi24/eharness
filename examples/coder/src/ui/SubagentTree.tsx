import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { AgentProgress } from '../contracts.ts'
import { color, sym } from './theme.ts'
import { firstLine } from './tool-summary.ts'

const MARK: Record<AgentProgress['status'], { symbol: string; color: string }> = {
  running: { symbol: '◐', color: color.running },
  done: { symbol: '✓', color: color.ok },
  failed: { symbol: '✗', color: color.error },
}

/** Progress of a subagent, nested under its `agent` tool card. */
export function SubagentTree({ progress }: { progress: AgentProgress }): ReactElement {
  const mark = MARK[progress.status]
  const lastText = progress.text.trim().split('\n').filter(Boolean).pop()
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text dimColor>{sym.branch} </Text>
        <Text color={mark.color}>{mark.symbol}</Text>
        <Text> {progress.agent}</Text>
        <Text dimColor>
          {' '}
          · {progress.steps} {progress.steps === 1 ? 'step' : 'steps'}
          {progress.lastTool ? ` · ${progress.lastTool}` : ''}
        </Text>
      </Text>
      {lastText ? (
        <Text dimColor wrap="truncate-end">
          {'    '}
          {firstLine(lastText, 120)}
        </Text>
      ) : null}
    </Box>
  )
}
