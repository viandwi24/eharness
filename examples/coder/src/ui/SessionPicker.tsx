import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { SessionSummary } from '../contracts.ts'
import { color, sym } from './theme.ts'

/** Props of {@link SessionPicker}. */
export interface SessionPickerProps {
  /** Loads the stored sessions (newest first). */
  load(): Promise<SessionSummary[]>
  onSelect(id: string): void
  /** Esc, or nothing to pick. */
  onCancel(): void
}

const VISIBLE = 10

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

  useInput((_input, key) => {
    if (key.escape) return onCancel()
    if (!sessions) return
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(sessions.length - 1, i + 1))
    else if (key.return) {
      const chosen = sessions[index]
      if (chosen) onSelect(chosen.id)
    }
  })

  if (!sessions) return <Text dimColor>Loading sessions…</Text>
  const first = Math.max(0, Math.min(index - Math.floor(VISIBLE / 2), sessions.length - VISIBLE))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={1}>
      <Text bold>Resume a session</Text>
      {sessions.slice(first, first + VISIBLE).map((s, i) => {
        const selected = first + i === index
        return (
          <Text key={s.id} wrap="truncate-end" color={selected ? color.accent : undefined}>
            {selected ? sym.pointer : ' '} {formatDate(s.updatedAt)}
            {'  '}
            {s.firstPrompt.split('\n')[0]?.slice(0, 80) ?? ''}
          </Text>
        )
      })}
      <Text dimColor>↑/↓ select · enter resume · esc new session</Text>
    </Box>
  )
}
