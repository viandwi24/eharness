/**
 * A subagent's conversation as a full-screen page (Claude Code's agent transcript view): the child
 * session rendered with the same components as the main transcript, live while the agent runs,
 * with a prompt that messages the agent (resuming a finished one).
 *
 * Live updates: the child session persists after every step, so the page polls `messagesOf`
 * while the agent runs (and reads once more when it settles).
 */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { BackgroundTask, CoderController, CoderMessage } from '../../contracts.ts'
import { PromptInput } from '../PromptInput.tsx'
import { color } from '../theme.ts'
import { fmtDuration } from './format.ts'
import { Page } from './Page.tsx'
import type { AgentViewTarget } from './spec.ts'
import { MessageEntry } from './TranscriptPage.tsx'

/** Poll interval of a running agent's stored messages. */
export const AGENT_POLL_MS = 600

const STATUS_WORD: Record<BackgroundTask['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/** Tool calls of the child that wait for an approval (the question shows at the main prompt). */
export function pendingApprovals(messages: CoderMessage[]): string[] {
  const last = messages.findLast((m) => m.role === 'assistant')
  if (last === undefined) return []
  const out: string[] = []
  for (const part of last.parts as unknown as Array<{
    type: string
    state?: string
    toolName?: string
  }>) {
    if (part.state !== 'approval-requested') continue
    out.push(
      part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.replace(/^tool-/, ''),
    )
  }
  return out
}

/** Props of {@link AgentPage}. */
export interface AgentPageProps {
  controller: CoderController
  target: AgentViewTarget
  onClose(): void
  size?: { rows: number; columns: number }
  /** Poll interval override (tests). */
  pollMs?: number
}

function sameMessages(a: CoderMessage[], b: CoderMessage[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

/** `◆ writer · general-purpose · running 12s`, and the task id with the description. */
export function agentHeader(
  target: AgentViewTarget,
  task: BackgroundTask | undefined,
  now: number,
): { title: string; subtitle: string } {
  const type = task?.agent ?? target.agent
  const state = task?.status ?? target.status
  const status = state === undefined ? 'finished' : STATUS_WORD[state]
  const elapsed = task ? ` ${fmtDuration(Math.max(0, (task.endedAt ?? now) - task.startedAt))}` : ''
  const who = type && type !== target.name ? `${target.name} · ${type}` : target.name
  const id = task?.id ?? target.taskId
  return {
    title: `◆ ${who} · ${status}${elapsed}`,
    subtitle: [id, target.description].filter(Boolean).join(' · '),
  }
}

/** The agent page. */
export function AgentPage({
  controller,
  target,
  onClose,
  size,
  pollMs = AGENT_POLL_MS,
}: AgentPageProps): ReactElement {
  const [messages, setMessages] = useState<CoderMessage[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [tasks, setTasks] = useState<BackgroundTask[]>(() => controller.tasks())
  const [now, setNow] = useState(() => Date.now())
  const [empty, setEmpty] = useState(true)
  const [expanded, setExpanded] = useState(false)
  useInput((input, key) => {
    if (key.ctrl && input === 'o') setExpanded((v) => !v)
  })
  const [note, setNote] = useState<{ text: string; tone: 'info' | 'error' } | undefined>()
  const task = tasks.find(
    (t) =>
      t.kind === 'agent' &&
      (t.sessionId === target.sessionId || (target.taskId !== undefined && t.id === target.taskId)),
  )
  const running = task ? task.status === 'running' : target.status === 'running'
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await controller.messagesOf(target.sessionId)
      setError(undefined)
      setMessages((prev) => (prev !== null && sameMessages(prev, next) ? prev : next))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [controller, target.sessionId])

  useEffect(() => controller.onTasks(setTasks), [controller])
  // read at once and whenever the status changes, then follow while running
  useEffect(() => {
    void load()
    if (!running) return
    const timer = setInterval(() => void load(), pollMs)
    return () => clearInterval(timer)
  }, [load, running, pollMs])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  const show = (text: string, tone: 'info' | 'error'): void => {
    setNote({ text, tone })
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(undefined), 6000)
  }
  const send = (text: string): void => {
    const message = text.trim()
    if (message === '') return
    controller
      .sendAgentMessage(target.sessionId, message)
      .then((result) => {
        if (!result.ok) show(result.error.replace(/^ERROR: /, ''), 'error')
        else
          show(
            result.status === 'resumed'
              ? `Resumed ${result.id} with your message.`
              : 'Message delivered; the agent sees it at its next step.',
            'info',
          )
        void load()
      })
      .catch((e: unknown) => show(e instanceof Error ? e.message : String(e), 'error'))
  }

  const head = agentHeader(target, task, now)
  const waiting = messages ? pendingApprovals(messages) : []
  const prompt = (
    <Box flexDirection="column">
      {note ? (
        <Text
          color={note.tone === 'error' ? color.error : undefined}
          dimColor={note.tone === 'info'}
        >
          {note.text}
        </Text>
      ) : null}
      <PromptInput
        history={[]}
        commands={[]}
        placeholder={`Message ${target.name}`}
        onSubmit={send}
        onTextChange={(text) => setEmpty(text === '')}
      />
    </Box>
  )
  return (
    <Page
      title={head.title}
      subtitle={head.subtitle}
      hints="esc close · enter message the agent · ctrl+o expand · ↑↓ PgUp/PgDn scroll"
      onClose={onClose}
      startAtEnd
      footer={prompt}
      footerEmpty={empty}
      size={size}
    >
      {messages === null && error === undefined ? <Text dimColor>Loading…</Text> : null}
      {error !== undefined ? (
        <Text color={color.error}>Cannot load the conversation: {error}</Text>
      ) : null}
      {messages !== null && messages.length === 0 ? <Text dimColor>(no messages yet)</Text> : null}
      {(messages ?? []).map((message) => (
        <MessageEntry key={message.id} message={message} expanded={expanded} />
      ))}
      {waiting.map((toolName, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a short, ordered list
        <Text key={i} color={color.warning}>
          ⏸ {target.name} is waiting for approval: {toolName}. Answer it at the main prompt.
        </Text>
      ))}
      {running && messages !== null && waiting.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>◐ {target.name} is working…</Text>
        </Box>
      ) : null}
    </Page>
  )
}
