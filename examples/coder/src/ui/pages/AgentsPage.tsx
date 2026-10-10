/** `/agents`: subagent definitions and the runs of this session; Enter opens a run's transcript. */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useState } from 'react'
import type { AgentDefinition } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import type { SubagentRun } from '../state.ts'
import { color, sym } from '../theme.ts'
import { Page, Section } from './Page.tsx'

const STATUS: Record<SubagentRun['status'], { mark: string; color: string | undefined }> = {
  running: { mark: '◐', color: color.running },
  completed: { mark: '✓', color: color.ok },
  failed: { mark: '✗', color: color.error },
  stopped: { mark: '■', color: undefined },
}

/** Props of {@link AgentsPage}. */
export interface AgentsPageProps {
  agents: AgentDefinition[]
  runs: SubagentRun[]
  /** Enter on a run. */
  onOpenRun(run: SubagentRun): void
  onClose(): void
  size?: { rows: number; columns: number }
}

/** The agents page. ↑/↓ select a run; the page scrolls with PgUp/PgDn. */
export function AgentsPage({
  agents,
  runs,
  onOpenRun,
  onClose,
  size,
}: AgentsPageProps): ReactElement {
  const [index, setIndex] = useState(Math.max(0, runs.length - 1))
  useInput((input, key) => {
    if (runs.length === 0) return
    const action = selectAction(input, key)
    if (action === 'accept') {
      const run = runs[index]
      if (run) onOpenRun(run)
    } else setIndex((i) => moveIndex(i, runs.length, action))
  })
  return (
    <Page
      title="Agents"
      subtitle={`${agents.length} defined · ${runs.length} run${runs.length === 1 ? '' : 's'} this session`}
      hints={
        runs.length > 0
          ? 'esc/q close · ↑↓ select run · enter open transcript · PgUp/PgDn scroll'
          : 'esc/q close · PgUp/PgDn scroll'
      }
      arrows={false}
      onClose={onClose}
      size={size}
    >
      <Section title="Definitions">
        {agents.length === 0 ? <Text dimColor>No subagents defined.</Text> : null}
        {agents.map((a) => (
          <Box key={a.name}>
            <Box width={22} flexShrink={0}>
              <Text color={color.accent} wrap="truncate-end">
                {a.name}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text dimColor>{a.source}</Text>
            </Box>
            <Text wrap="truncate-end">{a.description}</Text>
          </Box>
        ))}
      </Section>
      <Section title="Runs this session">
        {runs.length === 0 ? <Text dimColor>No subagent runs yet.</Text> : null}
        {runs.map((r, i) => (
          <Text
            key={r.toolCallId}
            wrap="truncate-end"
            color={i === index ? color.accent : undefined}
          >
            {i === index ? sym.pointer : ' '} {i + 1}.{' '}
            <Text color={STATUS[r.status].color}>{STATUS[r.status].mark}</Text> {r.name}
            <Text dimColor>
              {' '}
              · {r.status} · {r.description}
            </Text>
          </Text>
        ))}
      </Section>
    </Page>
  )
}
