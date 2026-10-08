import { Box, Text, useWindowSize } from 'ink'
import type { ReactElement } from 'react'
import type { ModelProvider, ThinkingLevel } from '../contracts.ts'
import { color, sym } from './theme.ts'

/** Props of {@link WelcomeBox}. */
export interface WelcomeBoxProps {
  cwd: string
  model: string
  provider?: ModelProvider
  thinking?: ThinkingLevel
  version?: string
}

/** `/Users/me/project` → `~/project` (when `home` is a prefix of the path). */
export function shortenHome(
  path: string,
  home = process.env.HOME ?? process.env.USERPROFILE,
): string {
  if (!home || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Shorten a path to at most `max` characters by replacing middle segments with `…`
 * (`/private/tmp/…/scratchpad/pty/proj`). Keeps the first two segments and as many trailing
 * segments as fit; falls back to a hard tail cut for very narrow widths.
 */
export function truncateMiddle(path: string, max: number): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  const lead = path.startsWith('/') ? 2 : 1
  const head = parts.slice(0, lead + 1).join('/')
  let tail: string[] = []
  for (let i = parts.length - 1; i > lead; i--) {
    const next = [parts[i] ?? '', ...tail]
    if (`${head}/…/${next.join('/')}`.length > max) break
    tail = next
  }
  if (tail.length > 0) return `${head}/…/${tail.join('/')}`
  return `…${path.slice(Math.max(0, path.length - Math.max(1, max - 1)))}`
}

/** The welcome banner: a rounded accent box with the setup of the session. */
export function WelcomeBox(props: WelcomeBoxProps): ReactElement {
  const { cwd, model, provider, thinking, version } = props
  const { columns } = useWindowSize()
  // border (2) + padding (2) + the indent and `cwd: ` label
  const cwdText = truncateMiddle(shortenHome(cwd), Math.max(10, columns - 4 - 1 - 5))
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.accent}
      paddingX={1}
      alignSelf="flex-start"
    >
      <Text>
        <Text color={color.accent}>{sym.star}</Text> <Text bold>Welcome to coder</Text>
        {version ? <Text dimColor> v{version}</Text> : null}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor> /help for help, /status for your current setup</Text>
        <Text dimColor> cwd: {cwdText}</Text>
        <Text dimColor>
          {' '}
          model: {model}
          {provider ? ` (${provider})` : ''}
          {thinking ? ` · thinking ${thinking}` : ''}
        </Text>
      </Box>
    </Box>
  )
}
