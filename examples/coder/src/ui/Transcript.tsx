import { Box, Static, Text } from 'ink'
import { type ReactElement, useRef } from 'react'
import type { CoderConfig, CoderMessage, ModelProvider, ThinkingLevel } from '../contracts.ts'
import { Branch } from './Branch.tsx'
import { keyedLines } from './keys.ts'
import { MessageView, UserMessage } from './MessageView.tsx'
import { ThinkingIndicator } from './Spinner.tsx'
import type { Entry, ViewState } from './state.ts'
import { color, sym } from './theme.ts'
import { toolView } from './tool-summary.ts'
import { WelcomeBox } from './WelcomeBox.tsx'

function EntryView({
  entry,
  config,
  state,
  welcome,
}: {
  entry: Entry
  config: CoderConfig
  state: ViewState
  welcome: WelcomeInfo
}): ReactElement | null {
  switch (entry.kind) {
    case 'header':
      return (
        <WelcomeBox
          cwd={config.root}
          model={config.model}
          {...(welcome.provider ? { provider: welcome.provider } : {})}
          {...(welcome.thinking ? { thinking: welcome.thinking } : {})}
          {...(welcome.version ? { version: welcome.version } : {})}
        />
      )
    case 'user':
      return <UserMessage text={entry.text} />
    case 'system':
      return (
        <Box marginTop={0}>
          <Text
            dimColor={entry.tone === 'info'}
            color={
              entry.tone === 'error'
                ? color.error
                : entry.tone === 'warn'
                  ? color.warning
                  : undefined
            }
          >
            {entry.text}
          </Text>
        </Box>
      )
    case 'shell': {
      const lines = entry.output ? entry.output.replace(/\s+$/, '').split('\n') : []
      const shown = lines.slice(0, 20)
      return (
        <Box flexDirection="column">
          <UserMessage text={`!${entry.command}`} />
          <Branch>
            {shown.length === 0 ? <Text dimColor>(No output)</Text> : null}
            {keyedLines(shown).map(({ key, line }) => (
              <Text key={key} dimColor>
                {line === '' ? ' ' : line}
              </Text>
            ))}
            {lines.length > shown.length ? (
              <Text dimColor>
                {sym.ellipsis} +{lines.length - shown.length} lines
              </Text>
            ) : null}
            <Text
              color={entry.exitCode === 0 ? undefined : color.error}
              dimColor={entry.exitCode === 0}
            >
              {entry.exitCode === null ? 'aborted' : `exit ${entry.exitCode}`}
            </Text>
          </Branch>
        </Box>
      )
    }
    case 'transcript':
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text dimColor>── transcript: {entry.title} (read-only) ──</Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderDimColor
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            paddingLeft={1}
          >
            {entry.messages.length === 0 ? <Text dimColor>(empty)</Text> : null}
            {entry.messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                expanded={false}
                bash={{}}
                timing={{}}
              />
            ))}
          </Box>
          <Text dimColor>── end of transcript ──</Text>
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

function hasLiveText(message: CoderMessage | null): boolean {
  return !!message?.parts.some((p) => p.type === 'text' && p.text.trim() !== '')
}

function hasRunningTool(message: CoderMessage | null): boolean {
  return !!message?.parts.some((p) => {
    const view = toolView(p)
    return (
      view !== null &&
      (view.state === 'input-streaming' || view.state === 'input-available' || !!view.preliminary)
    )
  })
}

/** Extra facts for the welcome box (all optional). */
export interface WelcomeInfo {
  provider?: ModelProvider
  thinking?: ThinkingLevel
  version?: string
}

/** Props of {@link Transcript}. */
export interface TranscriptProps {
  state: ViewState
  config: CoderConfig
  /** Provider, thinking level and version for the welcome box. */
  welcome?: WelcomeInfo
  /** Output tokens of the running turn for the thinking line. */
  tokens?: number
}

/** `Date.now()` of the moment `running` last became true (stable while it stays true). */
function useRunStart(running: boolean): number {
  const started = useRef(Date.now())
  const was = useRef(running)
  if (running && !was.current) started.current = Date.now()
  was.current = running
  return started.current
}

/** Finished entries once in `<Static>`, then the live assistant message. */
export function Transcript({ state, config, welcome = {}, tokens }: TranscriptProps): ReactElement {
  const live: CoderMessage | null = state.live
  const waiting = state.running && !hasLiveText(live) && !hasRunningTool(live)
  const startedAt = useRunStart(state.running)
  return (
    <>
      <Static key={state.epoch} items={state.entries}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column">
            <EntryView entry={entry} config={config} state={state} welcome={welcome} />
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
      {waiting ? (
        <ThinkingIndicator startedAt={startedAt} {...(tokens !== undefined ? { tokens } : {})} />
      ) : null}
    </>
  )
}
