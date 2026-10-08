/** `/btw`: an inline dim box that streams the answer to a side question. Not part of the transcript. */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { CoderController } from '../contracts.ts'
import { color } from './theme.ts'

/** Props of {@link SideQuestion}. */
export interface SideQuestionProps {
  controller: CoderController
  question: string
  /** Esc: close (aborts the request while it streams). */
  onClose(): void
}

/** The side question box. */
export function SideQuestion({ controller, question, onClose }: SideQuestionProps): ReactElement {
  const [answer, setAnswer] = useState('')
  const [state, setState] = useState<'streaming' | 'done' | 'error'>('streaming')
  const [error, setError] = useState('')
  const abort = useRef(new AbortController())

  // biome-ignore lint/correctness/useExhaustiveDependencies: ask once on mount
  useEffect(() => {
    const signal = abort.current.signal
    let text = ''
    controller
      .sideQuestion(
        question,
        (delta) => {
          text += delta
          setAnswer(text)
        },
        signal,
      )
      .then(
        (full) => {
          if (signal.aborted) return
          if (full) setAnswer(full)
          setState('done')
        },
        (e: unknown) => {
          if (signal.aborted) return
          setError(e instanceof Error ? e.message : String(e))
          setState('error')
        },
      )
    return () => abort.current.abort()
  }, [])

  useInput((_input, key) => {
    if (key.escape) {
      abort.current.abort()
      onClose()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.border} paddingX={1}>
      <Text dimColor bold wrap="truncate-end">
        /btw {question}
      </Text>
      {state === 'error' ? (
        <Text color={color.error}>{error}</Text>
      ) : (
        <Text dimColor>{answer || 'Thinking…'}</Text>
      )}
      <Text dimColor>{state === 'streaming' ? 'esc to cancel' : 'esc to dismiss'}</Text>
    </Box>
  )
}
