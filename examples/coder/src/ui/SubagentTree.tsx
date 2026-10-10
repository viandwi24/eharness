import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { AgentProgress } from '../contracts.ts'
import { Branch, Indent } from './Branch.tsx'
import { color, sym } from './theme.ts'
import { firstLine } from './tool-summary.ts'

/**
 * Progress of a subagent, nested under its `agent` tool card (`⎿  ↳ <last tool> (N steps)`, then
 * its latest text line).
 */
export function SubagentTree({ progress }: { progress: AgentProgress }): ReactElement {
  const steps = `${progress.steps} ${progress.steps === 1 ? 'step' : 'steps'}`
  const lastText = progress.text.trim().split('\n').filter(Boolean).pop()
  return (
    <Box flexDirection="column">
      <Branch>
        {progress.status === 'running' ? (
          <Text wrap="truncate-end" dimColor>
            {sym.arrow} {progress.lastTool ?? 'starting'} ({steps}) · {progress.agent}
          </Text>
        ) : progress.status === 'completed' ? (
          <Text wrap="truncate-end" dimColor>
            Done ({steps}) · {progress.agent}
          </Text>
        ) : progress.status === 'stopped' ? (
          <Text wrap="truncate-end" dimColor>
            Stopped ({steps}) · {progress.agent}
          </Text>
        ) : (
          <Text wrap="truncate-end" color={color.error}>
            Failed ({steps}) · {progress.agent}
          </Text>
        )}
      </Branch>
      {progress.status === 'running' && lastText ? (
        <Indent>
          <Text dimColor wrap="truncate-end">
            {firstLine(lastText, 120)}
          </Text>
        </Indent>
      ) : null}
    </Box>
  )
}
