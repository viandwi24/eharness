/** The transcript viewer (Ctrl+O): the whole conversation, tool cards expanded, scrollable. */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderMessage } from '../../contracts.ts'
import { MessageView, UserMessage } from '../MessageView.tsx'
import type { Entry } from '../state.ts'
import { color } from '../theme.ts'
import { shortModel } from './format.ts'
import { Page } from './Page.tsx'

function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Time and model of a stored message, when its metadata carries them. */
export function messageMeta(message: CoderMessage): { at?: number; model?: string } {
  const meta = (
    message.metadata as { eharness?: { createdAt?: number; model?: string } } | undefined
  )?.eharness
  return { at: meta?.createdAt, model: meta?.model }
}

export function MessageEntry({
  message,
  expanded = true,
}: {
  message: CoderMessage
  /** Tool cards expanded (the transcript viewer) or compact like the main transcript. */
  expanded?: boolean
}): ReactElement {
  const { at, model } = messageMeta(message)
  const stamp = [at === undefined ? undefined : clock(at), model ? shortModel(model) : undefined]
    .filter(Boolean)
    .join(' · ')
  return (
    <Box flexDirection="column" marginTop={1}>
      {message.role === 'assistant' && stamp ? <Text dimColor>── {stamp}</Text> : null}
      <MessageView message={message} expanded={expanded} bash={{}} timing={{}} />
    </Box>
  )
}

function EntryRow({ entry }: { entry: Entry }): ReactElement | null {
  switch (entry.kind) {
    case 'header':
      return null
    case 'user':
      return (
        <Box marginTop={1}>
          <UserMessage text={entry.text} />
        </Box>
      )
    case 'system':
      return (
        <Text
          dimColor={entry.tone === 'info'}
          color={
            entry.tone === 'error' ? color.error : entry.tone === 'warn' ? color.warning : undefined
          }
        >
          {entry.text}
        </Text>
      )
    case 'shell':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>! {entry.command}</Text>
          {entry.output ? <Text dimColor>{entry.output}</Text> : null}
          <Text dimColor>{entry.exitCode === null ? 'aborted' : `exit ${entry.exitCode}`}</Text>
        </Box>
      )
    case 'transcript':
      return (
        <Text dimColor>
          ── transcript: {entry.title} ({entry.messages.length} messages)
        </Text>
      )
    case 'message':
      return <MessageEntry message={entry.message} />
  }
}

/** Props of {@link TranscriptPage}. */
export interface TranscriptPageProps {
  title: string
  subtitle?: string
  entries: Entry[]
  onClose(): void
  size?: { rows: number; columns: number }
}

/** A scrollable, fully expanded view of `entries`. Opens at the end (the latest messages). */
export function TranscriptPage({
  title,
  subtitle,
  entries,
  onClose,
  size,
}: TranscriptPageProps): ReactElement {
  const visible = entries.filter((e) => e.kind !== 'header')
  return (
    <Page
      title={title}
      subtitle={subtitle ?? 'snapshot · tool output expanded'}
      onClose={onClose}
      hints="esc/q/ctrl+o close · ↑↓ PgUp/PgDn scroll · g/G top/bottom"
      startAtEnd
      size={size}
    >
      {visible.length === 0 ? <Text dimColor>(empty)</Text> : null}
      {visible.map((entry) => (
        <EntryRow key={entry.id} entry={entry} />
      ))}
    </Page>
  )
}
