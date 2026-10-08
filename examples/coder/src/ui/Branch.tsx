import { Box, Text } from 'ink'
import type { ReactElement, ReactNode } from 'react'
import { sym } from './theme.ts'

/** Width of the `  ⎿  ` gutter of a tool result. */
export const BRANCH_WIDTH = 5

/** A tool result line: the `⎿` gutter on the left, the content (wrapping) on the right. */
export function Branch({ children }: { children: ReactNode }): ReactElement {
  return (
    <Box>
      <Box flexShrink={0} width={BRANCH_WIDTH}>
        <Text dimColor>{`  ${sym.branch}  `}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

/** Content continuing under a {@link Branch}, aligned with its text. */
export function Indent({ children }: { children: ReactNode }): ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={BRANCH_WIDTH}>
      {children}
    </Box>
  )
}
