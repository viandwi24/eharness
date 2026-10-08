import { Box, Text, useWindowSize } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { CoderController, PermissionMode } from '../contracts.ts'
import { modeColor, modeLabel } from './theme.ts'

/** Props of {@link StatusBar}. */
export interface StatusBarProps {
  controller: CoderController
  mode: PermissionMode
  model: string
  running: boolean
  /** Bumped after each turn / command to refresh context and cost. */
  statsVersion: number
  /** Transient message (e.g. the Ctrl+C hint) replacing the key hints. */
  hint?: string | null
}

interface Stats {
  contextTokens: number
  contextWindow: number
  costUsd?: number
}

function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) {
      setSeconds(0)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [running])
  return seconds
}

/** Mode, model, context %, cost and key hints. */
export function StatusBar(props: StatusBarProps): ReactElement {
  const { controller, mode, model, running, statsVersion, hint } = props
  const { columns } = useWindowSize()
  const [stats, setStats] = useState<Stats | null>(null)
  const elapsed = useElapsed(running)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when statsVersion changes
  useEffect(() => {
    let cancelled = false
    controller
      .stats()
      .then((next) => {
        if (!cancelled) setStats(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [controller, statsVersion])

  const percent =
    stats && stats.contextWindow > 0
      ? Math.round((stats.contextTokens / stats.contextWindow) * 100)
      : undefined
  const hints = running ? 'esc interrupt · ctrl+o expand' : 'shift+tab mode · ctrl+o expand · /help'
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={modeColor(mode)} bold={mode !== 'default'}>
          {modeLabel(mode)}
        </Text>
        <Text dimColor> · {model}</Text>
        {percent !== undefined ? <Text dimColor> · context {percent}%</Text> : null}
        {stats?.costUsd !== undefined ? <Text dimColor> · ${stats.costUsd.toFixed(2)}</Text> : null}
        {running ? <Text color="yellow"> · working {elapsed}s</Text> : null}
        {columns >= 70 || hint ? <Text dimColor> · {hint ?? hints}</Text> : null}
      </Text>
    </Box>
  )
}
