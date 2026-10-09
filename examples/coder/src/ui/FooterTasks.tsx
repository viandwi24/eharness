/**
 * Background shells and agents as rows below the prompt (the reference TUI's agent panel). The App
 * owns the selection: Down from the prompt enters the rows, Left/Right/Up/Down move, Enter opens,
 * `x` stops, Esc leaves.
 */
import { Box, Text } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { BackgroundTask } from '../contracts.ts'
import { fmtDuration } from './pages/format.ts'
import { color } from './theme.ts'

/** Rows shown at once; the rest is summarised. */
export const MAX_FOOTER_ROWS = 5

/** The tasks the footer lists: the running ones, in start order. */
export function footerTasks(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.status === 'running')
}

/** `⧉ bash-1 · npm test · running 12s` / `◆ explore · Find auth code · running 12s`. */
export function taskRowText(task: BackgroundTask, now = Date.now()): string {
  const elapsed = fmtDuration(Math.max(0, (task.endedAt ?? now) - task.startedAt))
  if (task.kind === 'agent') {
    const at = task.label.indexOf(': ')
    const name = at > 0 ? task.label.slice(0, at) : task.id
    const what = at > 0 ? task.label.slice(at + 2) : task.label
    return `◆ ${name} · ${what} · ${task.status} ${elapsed}`
  }
  return `⧉ ${task.id} · ${task.label} · ${task.status} ${elapsed}`
}

/** Props of {@link FooterTasks}. */
export interface FooterTasksProps {
  tasks: BackgroundTask[]
  /** Index of the selected row, or null when the prompt has focus. */
  selected: number | null
}

/** The rows. Renders nothing without tasks. */
export function FooterTasks({ tasks, selected }: FooterTasksProps): ReactElement | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (tasks.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tasks.length])
  if (tasks.length === 0) return null
  // keep the selected row visible inside the window
  const start =
    selected !== null ? Math.max(0, Math.min(selected - MAX_FOOTER_ROWS + 1, tasks.length)) : 0
  const first = Math.min(start, Math.max(0, tasks.length - MAX_FOOTER_ROWS))
  const shown = tasks.slice(first, first + MAX_FOOTER_ROWS)
  return (
    <Box flexDirection="column" paddingX={2}>
      {shown.map((task, i) => {
        const on = selected === first + i
        return (
          <Text
            key={task.id}
            wrap="truncate-end"
            color={on ? color.accent : undefined}
            dimColor={!on}
            bold={on}
          >
            {on ? '❯ ' : '  '}
            {taskRowText(task, now)}
          </Text>
        )
      })}
      {tasks.length > MAX_FOOTER_ROWS ? (
        <Text dimColor>
          {'  '}
          {first + shown.length < tasks.length
            ? `↓ ${tasks.length - first - shown.length} more`
            : ''}
          {first > 0 ? ` ↑ ${first} above` : ''}
        </Text>
      ) : null}
      {selected !== null ? (
        <Text dimColor>←/→ select · enter open · x stop · esc back to prompt</Text>
      ) : null}
    </Box>
  )
}
