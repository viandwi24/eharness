import { Box, Text, useAnimation } from 'ink'
import { type ReactElement, useMemo } from 'react'
import { color, sym } from './theme.ts'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** A braille spinner; all instances share Ink's single animation timer. */
export function Spinner({ tint = color.running }: { tint?: string | undefined }): ReactElement {
  const { frame } = useAnimation({ interval: 80 })
  return <Text color={tint}>{FRAMES[frame % FRAMES.length]}</Text>
}

/** Verbs of the thinking line; one is picked per turn. */
export const VERBS: readonly string[] = [
  'Thinking',
  'Pondering',
  'Crafting',
  'Brewing',
  'Computing',
  'Noodling',
  'Percolating',
  'Reticulating',
  'Synthesizing',
  'Considering',
  'Tinkering',
  'Spelunking',
  'Cogitating',
  'Ruminating',
  'Musing',
  'Conjuring',
  'Marinating',
  'Puzzling',
]

/** A random verb of {@link VERBS}. */
export function pickVerb(random: () => number = Math.random): string {
  return VERBS[Math.floor(random() * VERBS.length)] ?? 'Thinking'
}

/** `950` → `950`, `1234` → `1.2k`, `15000` → `15k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)))
  const k = tokens / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
}

/** Props of {@link ThinkingIndicator}. */
export interface ThinkingIndicatorProps {
  /** `Date.now()` when the turn started; the verb is picked once per value. */
  startedAt: number
  /** Output tokens of the turn so far; shown as `↓ 1.2k tokens`. */
  tokens?: number
  /** Replaces the random verb (e.g. `Running bash`). */
  status?: string
  /** Replaces `esc to interrupt`. */
  hint?: string
}

/** `✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)` with an animated glyph. */
export function ThinkingIndicator(props: ThinkingIndicatorProps): ReactElement {
  const { startedAt, tokens, status, hint = 'esc to interrupt' } = props
  const { frame } = useAnimation({ interval: 150 })
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick a new verb per turn
  const verb = useMemo(() => pickVerb(), [startedAt])
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const parts = [`${seconds}s`]
  if (tokens !== undefined && tokens > 0) parts.push(`${sym.down} ${formatTokens(tokens)} tokens`)
  if (hint) parts.push(hint)
  return (
    <Box marginTop={1}>
      <Box flexShrink={0} width={2}>
        <Text color={color.accent}>{sym.spinner[frame % sym.spinner.length]}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={color.accent}>{status ?? verb}…</Text>
        <Text dimColor> ({parts.join(' · ')})</Text>
      </Text>
    </Box>
  )
}

/** The thinking line of a turn that started when this component mounted (or at `startedAt`). */
export function Thinking(props: Partial<ThinkingIndicatorProps> = {}): ReactElement {
  const fallback = useMemo(() => Date.now(), [])
  return <ThinkingIndicator {...props} startedAt={props.startedAt ?? fallback} />
}
