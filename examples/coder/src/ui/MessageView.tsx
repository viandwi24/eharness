import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderMessage } from '../contracts.ts'
import { keyedLines } from './keys.ts'
import type { ToolTiming } from './state.ts'
import { ToolCard } from './ToolCard.tsx'
import { color } from './theme.ts'
import { toolView } from './tool-summary.ts'

/** Props of {@link MessageView}. */
export interface MessageViewProps {
  message: CoderMessage
  expanded: boolean
  bash: Record<string, string>
  timing: Record<string, ToolTiming>
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g

/** Bold and inline code of a text line; everything else is plain. */
export function InlineText({ text }: { text: string }): ReactElement {
  const pieces = text.split(INLINE)
  return (
    <Text>
      {pieces.map((piece, i) => {
        const key = `${i}:${piece}`
        if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
          return (
            <Text key={key} bold>
              {piece.slice(2, -2)}
            </Text>
          )
        }
        if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
          return (
            <Text key={key} color={color.accent}>
              {piece.slice(1, -1)}
            </Text>
          )
        }
        return <Text key={key}>{piece}</Text>
      })}
    </Text>
  )
}

function changeFor(
  message: CoderMessage,
  input: unknown,
): { action: 'create' | 'write' | 'edit' | 'delete'; bytes?: number } | undefined {
  const path = (input as { path?: unknown } | null)?.path
  if (typeof path !== 'string') return undefined
  for (const part of message.parts) {
    if ((part.type as string) === 'data-filesystem.change') {
      const data = (part as unknown as { data: { path: string; action: never; bytes?: number } })
        .data
      if (data.path === path) return { action: data.action, bytes: data.bytes }
    }
  }
  return undefined
}

function kindLine(message: CoderMessage): string {
  const kind = message.metadata?.eharness?.kind ?? 'event'
  const part = message.parts.find((p) => p.type === `data-${kind}`) as
    | { data?: Record<string, unknown> }
    | undefined
  if (kind === 'eh.compaction') {
    const tokens = part?.data?.tokens as { before?: number; after?: number } | undefined
    return tokens
      ? `Conversation compacted (${tokens.before} → ${tokens.after} tokens)`
      : 'Conversation compacted'
  }
  const text = part?.data && typeof part.data.message === 'string' ? `: ${part.data.message}` : ''
  return `${kind.replace(/^eh\./, '')}${text}`
}

const SHELL_BLOCKS =
  /<shell-command>[\s\S]*?<\/shell-command>\s*<shell-output>[\s\S]*?<\/shell-output>\s*/g

function userText(message: CoderMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text.replace(SHELL_BLOCKS, '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** A finished or live message: user text, assistant text and tool cards. */
export function MessageView({
  message,
  expanded,
  bash,
  timing,
}: MessageViewProps): ReactElement | null {
  if (message.metadata?.eharness?.kind) {
    return (
      <Box marginTop={1}>
        <Text dimColor>── {kindLine(message)} ──</Text>
      </Box>
    )
  }
  if (message.role === 'user') {
    const text = userText(message)
    if (!text) return null
    return (
      <Box marginTop={1}>
        <Text color={color.user} bold>
          {'> '}
        </Text>
        <Text>{text}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {message.parts.map((part, i) => {
        const key = `${message.id}:${i}`
        if (part.type === 'text') {
          if (part.text.trim() === '') return null
          return (
            <Box key={key} marginTop={1} flexDirection="column">
              {keyedLines(part.text.split('\n')).map(({ key: lineKey, line }) => (
                <InlineText key={lineKey} text={line === '' ? ' ' : line} />
              ))}
            </Box>
          )
        }
        const view = toolView(part)
        if (view) {
          return (
            <ToolCard
              key={key}
              view={view}
              expanded={expanded}
              context={{
                bashLive: bash[view.toolCallId],
                timing: timing[view.toolCallId],
                change: changeFor(message, view.input),
              }}
            />
          )
        }
        return null
      })}
    </Box>
  )
}
