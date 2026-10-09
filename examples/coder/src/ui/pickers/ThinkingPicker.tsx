/** `/thinking` and Alt+T: pick the thinking (reasoning effort) level. */
import { Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import { type CoderController, THINKING_LEVELS, type ThinkingLevel } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { PickerFrame } from './PickerFrame.tsx'

/** What each level means, shown next to it. */
export const THINKING_HELP: Record<ThinkingLevel, string> = {
  'provider-default': 'let the provider decide',
  none: 'no thinking',
  minimal: 'a few tokens of reasoning',
  low: 'light reasoning, fast',
  medium: 'balanced',
  high: 'thorough reasoning',
  xhigh: 'deepest, slowest',
}

/** Props of {@link ThinkingPicker}. */
export interface ThinkingPickerProps {
  controller: CoderController
  onSelect(level: ThinkingLevel): void
  onCancel(): void
}

/** Inline thinking-level picker. */
export function ThinkingPicker({
  controller,
  onSelect,
  onCancel,
}: ThinkingPickerProps): ReactElement {
  const current = controller.thinking
  const [index, setIndex] = useState(Math.max(0, THINKING_LEVELS.indexOf(current)))
  const [unsupported, setUnsupported] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    controller
      .models()
      .then((list) => {
        const model = list.find((m) => m.id === controller.model)
        if (!cancelled && model && !model.reasoning) setUnsupported(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useInput((input, key) => {
    const action = selectAction(input, key)
    if (action === 'cancel') return onCancel()
    if (action === 'accept') {
      const level = THINKING_LEVELS[index]
      if (level) onSelect(level)
      return
    }
    setIndex((i) => moveIndex(i, THINKING_LEVELS.length, action))
  })

  return (
    <PickerFrame title="Thinking level" hint="↑/↓ select · enter apply · esc cancel">
      {unsupported ? (
        <Text color={color.warning}>
          ⚠ {controller.model} does not support reasoning; the level has no effect.
        </Text>
      ) : null}
      {THINKING_LEVELS.map((level, i) => (
        <Text key={level} color={i === index ? color.accent : undefined} wrap="truncate-end">
          {i === index ? sym.pointer : ' '} {level === current ? '✓' : ' '} {level}
          <Text dimColor> — {THINKING_HELP[level]}</Text>
        </Text>
      ))}
    </PickerFrame>
  )
}
