import { Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { SessionSummary } from '../contracts.ts'
import { PickerFrame, VISIBLE_ROWS, windowStart } from './pickers/PickerFrame.tsx'
import { moveIndex, selectAction } from './select.ts'
import { color, sym } from './theme.ts'

/** Props of {@link SessionPicker}. */
export interface SessionPickerProps {
  /** Loads the stored sessions (newest first). */
  load(): Promise<SessionSummary[]>
  onSelect(id: string): void
  /** Esc, or nothing to pick. */
  onCancel(): void
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** Up/Down + Enter list of stored sessions; Esc cancels. */
export function SessionPicker({ load, onSelect, onCancel }: SessionPickerProps): ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [index, setIndex] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    load()
      .then((list) => {
        if (cancelled) return
        if (list.length === 0) onCancel()
        else setSessions(list)
      })
      .catch(() => {
        if (!cancelled) onCancel()
      })
    return () => {
      cancelled = true
    }
  }, [])

  useInput((input, key) => {
    const action = selectAction(input, key)
    if (action === 'cancel') return onCancel()
    if (!sessions) return
    if (action === 'accept') {
      const chosen = sessions[index]
      if (chosen) onSelect(chosen.id)
      return
    }
    setIndex((i) => moveIndex(i, sessions.length, action, VISIBLE_ROWS))
  })

  if (!sessions) return <Text dimColor>Loading sessions…</Text>
  const first = windowStart(index, sessions.length)
  return (
    <PickerFrame title="Resume a session" hint="↑/↓ select · enter resume · esc new session">
      {sessions.slice(first, first + VISIBLE_ROWS).map((s, i) => {
        const selected = first + i === index
        return (
          <Text key={s.id} wrap="truncate-end" color={selected ? color.accent : undefined}>
            {selected ? sym.pointer : ' '}{' '}
            <Text dimColor={!selected}>{formatDate(s.updatedAt)}</Text>
            {'  '}
            {s.firstPrompt.split('\n')[0]?.slice(0, 80) ?? ''}
          </Text>
        )
      })}
    </PickerFrame>
  )
}
