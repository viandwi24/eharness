/** The shared frame of the inline pickers: rounded border, title, hint line. */
import { Box, Text } from 'ink'
import type { ReactElement, ReactNode } from 'react'
import { color } from '../theme.ts'

/** Rows of a list picker that are visible at once. */
export const VISIBLE_ROWS = 8

/** First visible index so that `index` stays inside a window of `size` rows. */
export function windowStart(index: number, count: number, size: number = VISIBLE_ROWS): number {
  return Math.max(0, Math.min(index - Math.floor(size / 2), count - size))
}

/** Rounded dialog below the prompt (classic coding-agent terminal style). */
export function PickerFrame({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: ReactNode
}): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={1}>
      <Text bold color={color.accent}>
        {title}
      </Text>
      {children}
      <Text dimColor>{hint}</Text>
    </Box>
  )
}
