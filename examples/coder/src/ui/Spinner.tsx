import { Text, useAnimation } from 'ink'
import type { ReactElement } from 'react'
import { color } from './theme.ts'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** A braille spinner; all instances share Ink's single animation timer. */
export function Spinner({ tint = color.running }: { tint?: string }): ReactElement {
  const { frame } = useAnimation({ interval: 80 })
  return <Text color={tint}>{FRAMES[frame % FRAMES.length]}</Text>
}

/** `thinking… 12s` while the model streams and no text has arrived yet. */
export function Thinking(): ReactElement {
  const { time } = useAnimation({ interval: 250 })
  return (
    <Text>
      <Spinner /> <Text dimColor>thinking… {Math.floor(time / 1000)}s</Text>
    </Text>
  )
}
