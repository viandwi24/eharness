import { Box, Static, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderConfig, CoderMessage } from '../contracts.ts'
import { MessageView } from './MessageView.tsx'
import type { Entry, ViewState } from './state.ts'
import { color } from './theme.ts'

function Header({ config }: { config: CoderConfig }): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={1}>
      <Text bold>coder</Text>
      <Text dimColor>{config.root}</Text>
      <Text dimColor>
        {config.model} · mode {config.mode} · type /help for commands
      </Text>
    </Box>
  )
}

function EntryView({
  entry,
  config,
  state,
}: {
  entry: Entry
  config: CoderConfig
  state: ViewState
}): ReactElement | null {
  switch (entry.kind) {
    case 'header':
      return <Header config={config} />
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={color.user} bold>
            {'> '}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      )
    case 'system':
      return (
        <Box marginTop={0}>
          <Text
            dimColor={entry.tone === 'info'}
            color={entry.tone === 'error' ? color.error : undefined}
          >
            {entry.text}
          </Text>
        </Box>
      )
    case 'message':
      return (
        <MessageView
          message={entry.message}
          expanded={state.expanded}
          bash={state.bash}
          timing={state.timing}
        />
      )
  }
}

/** Finished entries once in `<Static>`, then the live assistant message. */
export function Transcript({
  state,
  config,
}: {
  state: ViewState
  config: CoderConfig
}): ReactElement {
  const live: CoderMessage | null = state.live
  return (
    <>
      <Static key={state.epoch} items={state.entries}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column">
            <EntryView entry={entry} config={config} state={state} />
          </Box>
        )}
      </Static>
      {live ? (
        <MessageView
          message={live}
          expanded={state.expanded}
          bash={state.bash}
          timing={state.timing}
        />
      ) : null}
    </>
  )
}
