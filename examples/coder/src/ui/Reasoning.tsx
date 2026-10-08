import { Box, Text, useAnimation } from 'ink'
import { type ReactElement, useRef } from 'react'
import { Branch } from './Branch.tsx'
import { keyedLines } from './keys.ts'
import { sym } from './theme.ts'
import { firstLine } from './tool-summary.ts'

/** Props of {@link Reasoning}. */
export interface ReasoningProps {
  /** The reasoning text so far (empty or blank: redacted). */
  text: string
  /** `streaming` while the model is still thinking, `done` afterwards (AI SDK `state`). */
  state?: 'streaming' | 'done'
  /** Ctrl+O: the full text under `⎿` instead of its first line. */
  expanded: boolean
  /** Known duration in ms; otherwise measured from this component's first and last delta. */
  durationMs?: number
}

/** `12s` / `1m 05s` (whole seconds, at least `1s`). */
export function thoughtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Duration the part itself carries (`providerMetadata.eharness.durationMs`), if any. */
export function partDuration(part: unknown): number | undefined {
  const meta = (part as { providerMetadata?: Record<string, Record<string, unknown>> } | null)
    ?.providerMetadata
  const value = meta?.eharness?.durationMs
  return typeof value === 'number' && value >= 0 ? value : undefined
}

function Streaming(): ReactElement {
  const { frame } = useAnimation({ interval: 400 })
  return (
    <>
      <Box flexShrink={0} width={2}>
        <Text dimColor>{frame % 2 === 0 ? sym.star : sym.spinner[5]}</Text>
      </Box>
      <Text dimColor italic>
        Thinking{sym.ellipsis}
      </Text>
    </>
  )
}

/**
 * A reasoning part: `✻ Thinking…` while it streams, then `∴ Thought for 12s` with the first line
 * dim under `⎿` (the whole text, dim italic, when `expanded`). A blank text shows `∴ Thinking`.
 */
export function Reasoning({
  text,
  state = 'done',
  expanded,
  durationMs,
}: ReasoningProps): ReactElement {
  const first = useRef<number | undefined>(undefined)
  const last = useRef<number | undefined>(undefined)
  if (state === 'streaming') {
    first.current ??= Date.now()
    last.current = Date.now()
  } else if (first.current !== undefined) {
    last.current = Date.now()
  }
  const measured =
    first.current !== undefined && last.current !== undefined
      ? last.current - first.current
      : undefined
  const ms = durationMs ?? measured
  const body = text.trim()
  const streaming = state === 'streaming'

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {streaming ? (
          <Streaming />
        ) : (
          <>
            <Box flexShrink={0} width={2}>
              <Text dimColor>∴</Text>
            </Box>
            <Text dimColor italic>
              {body === ''
                ? 'Thinking'
                : ms === undefined
                  ? 'Thought'
                  : `Thought for ${thoughtDuration(ms)}`}
            </Text>
          </>
        )}
      </Box>
      {body !== '' && !streaming ? (
        <Branch>
          {expanded ? (
            keyedLines(body.split('\n')).map(({ key, line }) => (
              <Text key={key} dimColor italic>
                {line === '' ? ' ' : line}
              </Text>
            ))
          ) : (
            <Text dimColor wrap="truncate-end">
              {firstLine(body, 140)}
            </Text>
          )}
        </Branch>
      ) : null}
      {body !== '' && streaming && expanded ? (
        <Branch>
          {keyedLines(body.split('\n')).map(({ key, line }) => (
            <Text key={key} dimColor italic>
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </Branch>
      ) : null}
    </Box>
  )
}
