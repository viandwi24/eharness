/** `/help`: commands grouped by purpose, and the keyboard shortcuts. */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { slashCommands } from '../slash.ts'
import { color } from '../theme.ts'
import { Page, Section } from './Page.tsx'

const GROUPS: Array<{ title: string; names: string[] }> = [
  { title: 'Conversation', names: ['clear', 'compact', 'resume', 'plan', 'init', 'exit'] },
  { title: 'Model', names: ['model', 'thinking'] },
  {
    title: 'Inspect',
    names: ['context', 'status', 'cost', 'todos', 'agents', 'transcript', 'diff'],
  },
  { title: 'Safety', names: ['permissions'] },
  { title: 'Help', names: ['help'] },
]

/** `[keys, what it does]` rows of the shortcuts table. */
export const SHORTCUTS: Array<[string, string]> = [
  ['enter', 'send the prompt'],
  ['shift+enter, \\ enter', 'new line'],
  ['esc', 'interrupt the turn · close a page or picker'],
  ['shift+tab', 'cycle the permission mode'],
  ['alt+p, esc p', 'switch model'],
  ['alt+t', 'set the thinking level'],
  ['ctrl+o', 'open the full transcript'],
  ['ctrl+l', 'redraw the screen'],
  ['ctrl+c ×2', 'exit (the first press clears the input)'],
  ['↑ ↓', 'prompt history'],
  ['@path', 'mention a file (tab completes)'],
  ['!command', 'shell mode: run in the project root'],
  ['?', 'show shortcuts (empty prompt)'],
]

/** Commands in `slashCommands` that no group lists, so a new command is never missing. */
function otherNames(): string[] {
  const listed = new Set(GROUPS.flatMap((g) => g.names))
  return slashCommands.map((c) => c.name).filter((n) => !listed.has(n))
}

/** The body of the page. */
export function HelpBody(): ReactElement {
  const groups = [...GROUPS, { title: 'Other', names: otherNames() }].filter(
    (g) => g.names.length > 0,
  )
  return (
    <>
      {groups.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.names.map((name) => {
            const command = slashCommands.find((c) => c.name === name)
            if (!command) return null
            return (
              <Box key={name}>
                <Box width={30} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color={color.accent}>/{command.name}</Text>
                    {command.usage ? <Text dimColor> {command.usage}</Text> : null}
                  </Text>
                </Box>
                <Text wrap="truncate-end">{command.description}</Text>
              </Box>
            )
          })}
        </Section>
      ))}
      <Section title="Keyboard shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <Box key={keys}>
            <Box width={22} flexShrink={0}>
              <Text color={color.accent}>{keys}</Text>
            </Box>
            <Text wrap="truncate-end">{what}</Text>
          </Box>
        ))}
      </Section>
    </>
  )
}

/** The `/help` page. */
export function HelpPage({
  onClose,
  size,
}: {
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  return (
    <Page title="Help" subtitle="commands and keyboard shortcuts" onClose={onClose} size={size}>
      <HelpBody />
    </Page>
  )
}
