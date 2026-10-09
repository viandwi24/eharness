import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { CoderMessage } from '../contracts.ts'
import { InlineMarkdown, Markdown } from './markdown.tsx'
import { partDuration, Reasoning } from './Reasoning.tsx'
import { ReportBlock } from './ReportBlock.tsx'
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

const AGENT_FRAME = /^<agent-message from="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/agent-message>\s*$/

/**
 * A framed agent message (`<agent-message from="reviewer" …>text</agent-message>`) as a dim
 * `← reviewer: text` line; `undefined` when the text is not one.
 */
export function agentMessageLine(text: string): string | undefined {
  const frame = EVENT_FRAME.exec(text.trim())
  const match = AGENT_FRAME.exec(
    frame !== null && frame[1] === 'agent-message' ? (frame[2] ?? '').trim() : text.trim(),
  )
  if (match === null) return undefined
  const body = (match[2] ?? '').replace(/\s+/g, ' ').trim()
  return `← ${match[1]}: ${body.length > 200 ? `${body.slice(0, 199)}…` : body}`
}

const EVENT_FRAME = /^<event name="([^"]*)">([\s\S]*?)<\/event>\s*$/
const SUBAGENT_HEAD =
  /^(Background|Resumed) subagent (\S+)(?: "([^"]*)")? \(([^:)]*?)(?:: ([\s\S]*?))?\) (finished|failed|was stopped)\.(?:\n\n([\s\S]*))?$/

/** A report from another agent: header line and the report text (markdown). */
export interface AgentReport {
  head: string
  /** The report without its header, blank lines kept. */
  body: string
}

/**
 * A subagent completion event (`eh.event` name `subagent`) as the header `⏺ Message from writer ·
 * general-purpose · finished` plus the report, which the UI previews as markdown. `text` is the
 * event text (the data-eh.input part only carries the model framing `<event name="subagent">…
 * </event>`, which is unwrapped here); `undefined` when it is not a subagent report.
 */
export function subagentEventLine(
  text: string,
  data?: { name?: unknown; agent?: unknown; taskId?: unknown; status?: unknown },
): AgentReport | undefined {
  const frame = EVENT_FRAME.exec(text.trim())
  if (frame !== null && frame[1] !== 'subagent') return undefined
  const body = frame === null ? text.trim() : (frame[2] ?? '')
  const m = SUBAGENT_HEAD.exec(body)
  if (m === null) return undefined
  const who =
    (typeof data?.name === 'string' && data.name !== '' ? data.name : undefined) ?? m[3] ?? m[2]
  const verb = m[1] === 'Resumed' ? `${m[6]} (resumed)` : m[6]
  const type = typeof data?.agent === 'string' ? data.agent : m[4]
  return {
    head: `${sym.bullet} Message from ${who} · ${type} · ${verb}`,
    body: (m[7] ?? '').trim(),
  }
}

/** A message another agent sent to this one (`<agent-message from="writer" …>`) as a report. */
export function agentMessageReport(text: string): AgentReport | undefined {
  const frame = EVENT_FRAME.exec(text.trim())
  const match = AGENT_FRAME.exec(
    frame !== null && frame[1] === 'agent-message' ? (frame[2] ?? '').trim() : text.trim(),
  )
  if (match === null) return undefined
  return { head: `${sym.bullet} Message from ${match[1]}`, body: (match[2] ?? '').trim() }
}

/**
 * A `data-eh.input` part: input delivered inside the running turn (ADR-0011). `source: 'user'` is a
 * steered message (or an approval note, `approvalNote` set, shown as a dim `Note: ...` with the raw
 * note, not the framed `<user-note>` the model read); `source: 'event'` is a
 * next-step event (dim system line); `plugin:*` is hook context for the model and is hidden.
 */
export function SteeredInput({
  source,
  text,
  approvalNote,
  expanded = false,
}: {
  source: string
  text: string
  approvalNote?: { text: string }
  expanded?: boolean
}): ReactElement | null {
  if (source === 'user') {
    if (approvalNote !== undefined) {
      return (
        <Box marginTop={1}>
          <Text dimColor>Note: {approvalNote.text}</Text>
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
    const report = subagentEventLine(text) ?? agentMessageReport(text)
    if (report !== undefined) {
      return <ReportBlock head={report.head} body={report.body} expanded={expanded} />
    }
    return (
      <Box marginTop={1}>
        <Text dimColor>{`· ${text}`}</Text>
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

/** The report of an `eh.event` kind message from another agent, if it is one. */
function eventReport(message: CoderMessage): AgentReport | undefined {
  if (message.metadata?.eharness?.kind !== 'eh.event') return undefined
  const part = message.parts.find((p) => p.type === 'data-eh.event') as
    | { data?: Record<string, unknown> }
    | undefined
  const name = part?.data?.name
  const text = String(part?.data?.text ?? '')
  if (name === 'agent-message') return agentMessageReport(text)
  if (name === 'subagent') {
    const data = (part?.data?.data ?? undefined) as Parameters<typeof subagentEventLine>[1]
    return subagentEventLine(text, data)
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
    const report = eventReport(message)
    if (report !== undefined) {
      return <ReportBlock head={report.head} body={report.body} expanded={expanded} />
    }
    const line = kindLine(message)
    return (
      <Box marginTop={1}>
        <Text dimColor>{`── ${line} ──`}</Text>
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
          const data = (
            part as unknown as {
              data?: { source?: string; text?: string; approvalNote?: { text?: string } }
            }
          ).data
          if (typeof data?.text !== 'string') return null
          const note = data.approvalNote
          return (
            <SteeredInput
              key={key}
              source={data.source ?? 'user'}
              text={data.text}
              expanded={expanded}
              {...(typeof note?.text === 'string' ? { approvalNote: { text: note.text } } : {})}
            />
          )
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
