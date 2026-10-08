import { Box, Text, useWindowSize } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { CoderController, PermissionMode, ThinkingLevel } from '../contracts.ts'
import { color, useTheme } from './theme.ts'

/** Props of {@link Footer}. */
export interface FooterProps {
  mode: PermissionMode
  model: string
  thinking: ThinkingLevel
  /** Percent of the context window left before auto-compaction (shown at 20% or less). */
  contextLeftPct?: number
  costUsd?: number
  /** Transient message (e.g. the Ctrl+C hint); replaces the mode indicator. */
  hint?: string | null
  /** The `?` panel is open: the left side shows `? for shortcuts` only when closed. */
  shortcutsOpen?: boolean
  /** A turn is running. */
  busy?: boolean
  /** Vim mode label shown at the far left (`INSERT` renders as `-- INSERT --`). */
  vimMode?: string
  /** Output of the user's status line command; replaces the right side (ANSI allowed). */
  statusLine?: string
  /** Running background tasks (`⧉ N background` when above 0). */
  tasks?: number
  /** Session name, dim, left of the model. */
  sessionName?: string
}

/** `anthropic/claude-sonnet-4.6` → `claude-sonnet-4.6`. */
export function shortModel(model: string): string {
  const at = model.lastIndexOf('/')
  return at >= 0 ? model.slice(at + 1) : model
}

/** Text and color of the left side of the footer for a permission mode. */
export function modeIndicator(mode: PermissionMode): { text: string; color: string | undefined } {
  switch (mode) {
    case 'acceptEdits':
      return { text: '⏵⏵ accept edits on (shift+tab to cycle)', color: color.acceptEdits }
    case 'plan':
      return { text: '⏸ plan mode on (shift+tab to cycle)', color: color.plan }
    case 'bypassPermissions':
      return { text: '⏵⏵ bypass permissions on', color: color.bypass }
    case 'dontAsk':
      return { text: "⏵⏵ don't ask on (shift+tab to cycle)", color: color.warning }
    default:
      return { text: '? for shortcuts', color: undefined }
  }
}

/** Below the prompt box: mode indicator on the left, model, thinking and context on the right. */
export function Footer(props: FooterProps): ReactElement {
  const { mode, model, thinking, contextLeftPct, costUsd, hint, shortcutsOpen, busy } = props
  const { vimMode, statusLine, tasks, sessionName } = props
  useTheme()
  const indicator = modeIndicator(mode)
  const low = contextLeftPct !== undefined && contextLeftPct <= 20
  const left =
    hint ?? (shortcutsOpen && mode === 'default' ? '? to close shortcuts' : indicator.text)
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box flexShrink={0}>
        {vimMode ? (
          <Text bold>{vimMode.startsWith('--') ? vimMode : `-- ${vimMode.toUpperCase()} --`} </Text>
        ) : null}
        <Text
          color={hint ? undefined : indicator.color}
          dimColor={hint ? false : indicator.color === undefined}
        >
          {left}
          {busy && !hint ? <Text dimColor> · esc to interrupt</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={1} marginLeft={2}>
        <Text wrap="truncate-end">
          {statusLine ? (
            statusLine
          ) : (
            <>
              {tasks !== undefined && tasks > 0 ? (
                <Text dimColor>⧉ {tasks} background · </Text>
              ) : null}
              {sessionName ? <Text dimColor>{sessionName} · </Text> : null}
              {low ? (
                <Text color={(contextLeftPct as number) <= 10 ? color.error : color.warning}>
                  Context left until auto-compact: {contextLeftPct}%<Text dimColor> · </Text>
                </Text>
              ) : null}
              <Text dimColor>
                {shortModel(model)} · thinking {thinking}
                {costUsd !== undefined ? ` · $${costUsd.toFixed(2)}` : ''}
              </Text>
            </>
          )}
        </Text>
      </Box>
    </Box>
  )
}

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['! for bash mode', 'shift+tab to cycle modes'],
  ['/ for commands', 'alt+p to switch model'],
  ['@ for file paths', 'alt+t to change thinking'],
  ['\\⏎ / ctrl+j for newline', 'ctrl+o for transcript'],
  ['esc to interrupt', 'ctrl+c to exit'],
]

/** The two-column shortcut list shown when `?` is pressed on an empty prompt. */
export function ShortcutsPanel(): ReactElement {
  return (
    <Box flexDirection="column" paddingX={2}>
      {SHORTCUTS.map(([a, b]) => (
        <Box key={a}>
          <Box width={32}>
            <Text dimColor>{a}</Text>
          </Box>
          <Text dimColor>{b}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** Props of {@link StatusBar}. */
export interface StatusBarProps {
  controller: CoderController
  mode: PermissionMode
  model: string
  running: boolean
  /** Bumped after each turn / command to refresh context and cost. */
  statsVersion: number
  hint?: string | null
  /** Defaults to the controller's current thinking level. */
  thinking?: ThinkingLevel
  shortcutsOpen?: boolean
}

/** A {@link Footer} that loads context and cost from the controller (kept for the App). */
export function StatusBar(props: StatusBarProps): ReactElement {
  const { controller, mode, model, running, statsVersion, hint, shortcutsOpen } = props
  const { columns } = useWindowSize()
  const [stats, setStats] = useState<{
    contextTokens: number
    contextWindow: number
    costUsd?: number
  } | null>(null)
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
  const left =
    stats && stats.contextWindow > 0
      ? Math.max(0, Math.round(100 - (stats.contextTokens / stats.contextWindow) * 100))
      : undefined
  return (
    <Footer
      mode={mode}
      model={model}
      thinking={props.thinking ?? controller.thinking}
      {...(left !== undefined ? { contextLeftPct: left } : {})}
      {...(stats?.costUsd !== undefined && columns >= 70 ? { costUsd: stats.costUsd } : {})}
      hint={hint ?? null}
      shortcutsOpen={shortcutsOpen ?? false}
      busy={running}
    />
  )
}
