/** `/output-style`: pick the response style. */
import { Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { CoderController } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { PickerFrame } from './PickerFrame.tsx'

/** Props of {@link OutputStylePicker}. */
export interface OutputStylePickerProps {
  controller: CoderController
  onSelect(name: string): void
  onCancel(): void
}

/** Inline output-style picker. */
export function OutputStylePicker({
  controller,
  onSelect,
  onCancel,
}: OutputStylePickerProps): ReactElement {
  const [styles, setStyles] = useState<Array<{ name: string; description: string }> | null>(null)
  const [index, setIndex] = useState(0)
  const current = (controller.setting('outputStyle') as string | undefined) ?? 'default'

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    controller
      .outputStyles()
      .then((list) => {
        if (cancelled) return
        if (list.length === 0) return onCancel()
        setStyles(list)
        setIndex(
          Math.max(
            0,
            list.findIndex((s) => s.name === current),
          ),
        )
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
    if (!styles) return
    if (action === 'accept') {
      const picked = styles[index]
      if (picked) onSelect(picked.name)
      return
    }
    setIndex((i) => moveIndex(i, styles.length, action))
  })

  if (!styles) return <Text dimColor>Loading output styles…</Text>
  return (
    <PickerFrame title="Output style" hint="↑/↓ select · enter apply · esc cancel">
      {styles.map((s, i) => (
        <Text key={s.name} wrap="truncate-end" color={i === index ? color.accent : undefined}>
          {i === index ? sym.pointer : ' '} {s.name === current ? '✓' : ' '} {s.name}
          <Text dimColor> — {s.description}</Text>
        </Text>
      ))}
    </PickerFrame>
  )
}
