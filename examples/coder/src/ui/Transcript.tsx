import { Box, Static, Text, useWindowSize } from 'ink'
import { type ReactElement, useRef } from 'react'
import type { CoderConfig, CoderMessage, ModelProvider, ThinkingLevel } from '../contracts.ts'
import { Branch } from './Branch.tsx'
import { keyedLines } from './keys.ts'
import { MessageView, UserMessage } from './MessageView.tsx'
import { ThinkingIndicator } from './Spinner.tsx'
import type { Entry, ViewState } from './state.ts'
import { color, sym, useTheme } from './theme.ts'
import { WelcomeBox } from './WelcomeBox.tsx'

function EntryView({
  entry,
  config,
  state,
  welcome,
  focus,
}: {
  entry: Entry
  config: CoderConfig
  state: ViewState
  welcome: WelcomeInfo
  focus: boolean
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
          focus={focus}
        />
      )
  }
}

/**
 * Parts of the step the model is working on: everything after the last `step-start`. A
 * `respond()` continuation streams into the previous message, so the whole message already holds
 * text, reasoning and tool parts of earlier steps; only the current step says whether the agent
 * is visibly producing something right now.
 */
function currentStepParts(message: CoderMessage | null): CoderMessage['parts'] {
  if (message === null) return []
  const parts = message.parts
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === 'step-start') return parts.slice(i + 1)
  }
  return parts
}

function hasStreamingReasoning(parts: CoderMessage['parts']): boolean {
  return parts.some(
    (p) => p.type === 'reasoning' && (p as { state?: string }).state === 'streaming',
  )
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
  /** Focus view: last prompt and final text in full, tool calls on one line. */
  focus?: boolean
  /**
   * Extra rows the caller renders below beyond the {@link LIVE_RESERVE} baseline (footer task
   * rows, queued messages). Ink repaints the whole terminal on every frame once the live area is
   * as tall as the terminal, which copies the top of a long streaming text into the scrollback.
   */
  extraReserve?: number
}

/** `Date.now()` of the moment `running` last became true (stable while it stays true). */
function useRunStart(running: boolean): number {
  const started = useRef(Date.now())
  const was = useRef(running)
  if (running && !was.current) started.current = Date.now()
  was.current = running
  return started.current
}

/** Terminal rows kept free for what renders below the live tail (indicator, dialog, prompt, footer). */
export const LIVE_RESERVE = 16

/** Finished entries once in `<Static>`, then the live assistant message. */
export function Transcript({
  state,
  config,
  welcome = {},
  tokens,
  focus = false,
  extraReserve = 0,
}: TranscriptProps): ReactElement {
  useTheme()
  const live: CoderMessage | null = state.live
  // The indicator shows for the whole turn (also while text streams and tools run, also in a
  // continuation after an approval or a dismissed question); only a reasoning block that is
  // streaming in the current step replaces it with its own "Thinking…" line.
  const waiting = state.running && !hasStreamingReasoning(currentStepParts(live))
  const startedAt = useRunStart(state.running)
  // <Static> lays its items out absolutely, without the terminal width: give each entry the width
  // explicitly, or a row like `⏺ text` wraps its text at the full width plus the bullet column and
  // the terminal hard-wraps the overflow mid-word.
  const { columns, rows } = useWindowSize()
  // Only the uncommitted tail of the live message is rendered live (see `committableCount`).
  const tail: CoderMessage | null =
    live && live.parts.length > state.committed
      ? state.committed === 0
        ? live
        : { ...live, parts: live.parts.slice(state.committed) }
      : null
  return (
    <>
      <Static key={state.epoch} items={state.entries}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column" width={columns}>
            <EntryView
              entry={entry}
              config={config}
              state={state}
              welcome={welcome}
              focus={focus}
            />
          </Box>
        )}
      </Static>
      {tail ? (
        // Defensive cap: a tail taller than the terminal would be repainted into the scrollback
        // on every frame. Clip it to the last `rows - LIVE_RESERVE` lines (the prompt, footer and
        // dialogs live below), like Claude Code showing the tail of long streaming output.
        <Box
          flexDirection="column"
          justifyContent="flex-end"
          overflowY="hidden"
          maxHeight={Math.max(4, rows - LIVE_RESERVE - extraReserve)}
          flexShrink={0}
        >
          <Box flexDirection="column" flexShrink={0}>
            <MessageView
              message={tail}
              expanded={state.expanded}
              bash={state.bash}
              timing={state.timing}
              focus={focus}
            />
          </Box>
        </Box>
      ) : null}
      {waiting ? (
        <ThinkingIndicator startedAt={startedAt} {...(tokens !== undefined ? { tokens } : {})} />
      ) : null}
    </>
  )
}
