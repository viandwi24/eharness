import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderMessage } from '../contracts.ts'
import { InlineMarkdown, Markdown } from './markdown.tsx'
import { partDuration, Reasoning } from './Reasoning.tsx'
import type { ToolTiming } from './state.ts'
import { ToolCard, ToolLine } from './ToolCard.tsx'
import { color, sym } from './theme.ts'
import { toolView } from './tool-summary.ts'

/** Props of {@link MessageView}. */
export interface MessageViewProps {
  message: CoderMessage
  expanded: boolean
  bash: Record<string, string>
  timing: Record<string, ToolTiming>
  /** Focus view: tool calls on one line, reasoning hidden, only the final text shown. */
  focus?: boolean
}

/** Inline Markdown of one line (kept for compatibility; see `markdown.tsx`). */
export function InlineText({ text }: { text: string }): ReactElement {
  return <InlineMarkdown text={text} />
}

/**
 * A prompt the user sent: `> text` on a gray quoted background; `!cmd` shows as `! cmd` in the
 * shell color.
 */
export function UserMessage({ text }: { text: string }): ReactElement {
  const shell = text.startsWith('!')
  return (
    <Box marginTop={1} backgroundColor={shell ? undefined : color.userBg}>
      <Box flexShrink={0} width={2}>
        <Text color={shell ? color.shell : color.user}>{shell ? '!' : sym.prompt}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        <Text color={shell ? color.shell : undefined}>
          {shell ? text.slice(1).trimStart() : text}
        </Text>
      </Box>
    </Box>
  )
}

const APPROVAL_NOTE = /^Note from the user about the approved \S+ call:\s*([\s\S]*)$/

/**
 * A `data-eh.input` part: input delivered inside the running turn (ADR-0011). `source: 'user'` is a
 * steered message (or an approval note, shown as a dim `Note: ...`); `source: 'event'` is a
 * next-step event (dim system line); `plugin:*` is hook context for the model and is hidden.
 */
export function SteeredInput({
  source,
  text,
}: {
  source: string
  text: string
}): ReactElement | null {
  if (source === 'user') {
    const note = APPROVAL_NOTE.exec(text)
    if (note) {
      return (
        <Box marginTop={1}>
          <Text dimColor>Note: {note[1]}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <UserMessage text={text} />
        <Text dimColor> (sent while the agent was working)</Text>
      </Box>
    )
  }
  if (source === 'event') {
    return (
      <Box marginTop={1}>
        <Text dimColor>· {text}</Text>
      </Box>
    )
  }
  return null
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
  focus = false,
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
    return <UserMessage text={text} />
  }
  let lastText = -1
  if (focus) {
    message.parts.forEach((p, i) => {
      if (p.type === 'text' && p.text.trim() !== '') lastText = i
    })
  }
  return (
    <Box flexDirection="column">
      {message.parts.map((part, i) => {
        const key = `${message.id}:${i}`
        if (part.type === 'text') {
          if (part.text.trim() === '') return null
          if (focus && i !== lastText) return null
          return (
            <Box key={key} marginTop={1}>
              <Box flexShrink={0} width={2}>
                <Text color={color.text}>{sym.bullet}</Text>
              </Box>
              <Markdown text={part.text} />
            </Box>
          )
        }
        if (part.type === 'reasoning') {
          if (focus) return null
          const r = part as { text: string; state?: 'streaming' | 'done' }
          const ms = partDuration(part)
          return (
            <Reasoning
              key={key}
              text={r.text}
              state={r.state}
              expanded={expanded}
              {...(ms !== undefined ? { durationMs: ms } : {})}
            />
          )
        }
        if ((part.type as string) === 'data-eh.input') {
          const data = (part as unknown as { data?: { source?: string; text?: string } }).data
          if (typeof data?.text !== 'string') return null
          return <SteeredInput key={key} source={data.source ?? 'user'} text={data.text} />
        }
        const view = toolView(part)
        if (view) {
          if (focus) {
            return (
              <ToolLine
                key={key}
                view={view}
                context={{
                  bashLive: bash[view.toolCallId],
                  timing: timing[view.toolCallId],
                  change: changeFor(message, view.input),
                }}
              />
            )
          }
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
