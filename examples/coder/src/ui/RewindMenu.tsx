/** `/rewind` and double Esc: pick a past prompt, then choose what to restore. */
import { Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { CoderController, RewindPoint, RewindResult } from '../contracts.ts'
import { fmtAgo } from './pages/format.ts'
import { PickerFrame, VISIBLE_ROWS, windowStart } from './pickers/PickerFrame.tsx'
import { moveIndex, selectAction } from './select.ts'
import { color, sym } from './theme.ts'

type What = 'both' | 'conversation' | 'code'

const ACTIONS: Array<{ what: What | 'cancel'; label: string }> = [
  { what: 'both', label: 'Restore code and conversation' },
  { what: 'conversation', label: 'Restore conversation' },
  { what: 'code', label: 'Restore code' },
  { what: 'cancel', label: 'Cancel' },
]

/** Props of {@link RewindMenu}. */
export interface RewindMenuProps {
  controller: CoderController
  /** The rewind finished. */
  onDone(result: RewindResult): void
  /** Esc, no points, or a failure (`reason` is shown as a system line). */
  onCancel(reason?: string): void
}

/** One line of a prompt, truncated. */
function oneLine(text: string, max = 60): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Inline two-step rewind dialog. */
export function RewindMenu({ controller, onDone, onCancel }: RewindMenuProps): ReactElement {
  const [points, setPoints] = useState<RewindPoint[] | null>(null)
  const [index, setIndex] = useState(0)
  const [chosen, setChosen] = useState<RewindPoint | null>(null)
  const [action, setAction] = useState(0)
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    controller
      .rewindPoints()
      .then((list) => {
        if (cancelled) return
        if (list.length === 0) onCancel('Nothing to rewind to yet.')
        else setPoints([...list].sort((a, b) => b.at - a.at))
      })
      .catch((error: unknown) => {
        if (!cancelled) onCancel(`Cannot rewind: ${error instanceof Error ? error.message : error}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useInput((input, key) => {
    if (busy) return
    const act = selectAction(input, key)
    if (act === 'cancel') return chosen ? setChosen(null) : onCancel()
    if (!points) return
    if (!chosen) {
      if (act === 'accept') {
        const point = points[index]
        if (point) {
          setChosen(point)
          setAction(0)
        }
        return
      }
      setIndex((i) => moveIndex(i, points.length, act, VISIBLE_ROWS))
      return
    }
    if (act === 'accept') {
      const picked = ACTIONS[action]
      if (!picked || picked.what === 'cancel') return onCancel()
      setBusy(true)
      controller.rewind(chosen.messageId, picked.what).then(
        (result) => onDone(result),
        (error: unknown) =>
          onCancel(`Rewind failed: ${error instanceof Error ? error.message : error}`),
      )
      return
    }
    setAction((i) => moveIndex(i, ACTIONS.length, act))
  })

  if (!points) return <Text dimColor>Loading rewind points…</Text>
  if (chosen) {
    return (
      <PickerFrame title="Rewind" hint="↑/↓ select · enter apply · esc back">
        <Text dimColor wrap="truncate-end">
          {oneLine(chosen.text)}
        </Text>
        {ACTIONS.map((a, i) => (
          <Text key={a.what} color={i === action ? color.accent : undefined}>
            {i === action ? sym.pointer : ' '} {a.label}
            {busy && i === action ? '…' : ''}
          </Text>
        ))}
      </PickerFrame>
    )
  }
  const first = windowStart(index, points.length)
  return (
    <PickerFrame title="Rewind to a previous prompt" hint="↑/↓ select · enter choose · esc cancel">
      {points.slice(first, first + VISIBLE_ROWS).map((p, i) => {
        const selected = first + i === index
        return (
          <Text key={p.messageId} wrap="truncate-end" color={selected ? color.accent : undefined}>
            {selected ? sym.pointer : ' '} {oneLine(p.text)}
            <Text dimColor>
              {'  '}
              {fmtAgo(p.at)}
              {p.files.length > 0
                ? ` · ${p.files.length} file${p.files.length === 1 ? '' : 's'} changed`
                : ' · no file changes'}
            </Text>
          </Text>
        )
      })}
    </PickerFrame>
  )
}
