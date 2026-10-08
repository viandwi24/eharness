import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { color } from './theme.ts'

/** Marker in front of a queued message. */
export const QUEUED_MARK = '⧗'

/** Messages typed while a turn runs, shown in gray above the prompt until they are delivered. */
export function QueuedMessages({ items }: { items: readonly string[] }): ReactElement | null {
  if (items.length === 0) return null
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((text, i) => {
        const [first = '', ...rest] = text.split('\n')
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries are plain strings in queue order
          <Text key={`${i}:${text}`} color={color.dim} wrap="truncate-end">
            {QUEUED_MARK} {first}
            {rest.length > 0 ? ' …' : ''}
          </Text>
        )
      })}
    </Box>
  )
}
