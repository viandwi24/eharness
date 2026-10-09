/** `/tasks`: background shell commands and subagents. */
import { Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { BackgroundTask, CoderController } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { fmtDuration } from './format.ts'
import { Page, Section } from './Page.tsx'

const STATUS_COLOR: Record<BackgroundTask['status'], string | undefined> = {
  running: color.warning,
  completed: color.ok,
  failed: color.error,
  stopped: undefined,
}

/** The tasks page: ↑↓ select, Enter shows the output, `x` stops a running task. */
export function TasksPage({
  controller,
  onClose,
  onOpenAgent,
  initialTaskId,
  size,
}: {
  controller: CoderController
  onClose(): void
  /** Enter on an agent: open its conversation (without it, Enter shows the agent's output text). */
  onOpenAgent?(task: BackgroundTask): void
  /** Open with this task selected and its output shown (Enter on a footer row). */
  initialTaskId?: string
  size?: { rows: number; columns: number }
}): ReactElement {
  const [tasks, setTasks] = useState<BackgroundTask[]>(() => controller.tasks())
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      controller.tasks().findIndex((t) => t.id === initialTaskId),
    ),
  )
  const [open, setOpen] = useState<{ id: string; text: string } | null>(() => {
    const t = controller.tasks().find((x) => x.id === initialTaskId)
    return t ? { id: t.id, text: t.tail } : null
  })
  useEffect(() => controller.onTasks(setTasks), [controller])
  const selected = tasks[Math.min(index, tasks.length - 1)]

  // a shown output follows its task
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the task list changes
  useEffect(() => {
    if (!open) return
    let cancelled = false
    controller
      .taskOutput(open.id)
      .then((text) => {
        if (!cancelled)
          setOpen((o) => (o && o.id === open.id && o.text !== text ? { ...o, text } : o))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [controller, open?.id, tasks])

  useInput((input, key) => {
    const action = selectAction(input, key)
    if (action && action !== 'accept' && action !== 'cancel') {
      setIndex((i) => moveIndex(i, tasks.length, action))
    } else if (key.return && selected) {
      if (selected.kind === 'agent' && onOpenAgent) onOpenAgent(selected)
      else if (open?.id === selected.id) setOpen(null)
      else setOpen({ id: selected.id, text: selected.tail })
    } else if (input === 'x' && selected?.status === 'running') {
      void controller.stopTask(selected.id).catch(() => {})
    }
  })

  return (
    <Page
      title="Tasks"
      subtitle="background shells and agents"
      hints="esc/q close · ↑↓ select · enter open agent / show output · x stop"
      arrows={false}
      onClose={onClose}
      size={size}
    >
      <Section>
        {tasks.length === 0 ? <Text dimColor>No background tasks.</Text> : null}
        {tasks.map((t, i) => (
          <Text key={t.id} wrap="truncate-end" color={i === index ? color.accent : undefined}>
            {i === index ? sym.pointer : ' '} {t.id} <Text dimColor>{t.kind}</Text>{' '}
            <Text color={STATUS_COLOR[t.status]}>{t.status}</Text>
            <Text dimColor>
              {' '}
              {fmtDuration((t.endedAt ?? Date.now()) - t.startedAt)} · {t.label}
            </Text>
          </Text>
        ))}
      </Section>
      {open ? (
        <Section title={`Output of ${open.id}`}>
          <Text>{open.text || '(no output yet)'}</Text>
        </Section>
      ) : null}
    </Page>
  )
}
