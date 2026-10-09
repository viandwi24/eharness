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
  /** Auto mode paused after repeated classifier blocks (shown instead of `auto mode on`). */
  autoPaused?: boolean
  /** The prompt is empty: `· ? for shortcuts` follows the mode (default true). */
  inputEmpty?: boolean
}

/** `anthropic/claude-sonnet-4.6` → `claude-sonnet-4.6`. */
export function shortModel(model: string): string {
  const at = model.lastIndexOf('/')
  return at >= 0 ? model.slice(at + 1) : model
}

/** What the left side of the footer says for a permission mode ("the reference TUI" wording). */
export function modeIndicator(
  mode: PermissionMode,
  autoPaused = false,
): { text: string; color: string | undefined } {
  switch (mode) {
    case 'auto':
      // paused after repeated blocks: calls ask until one is approved (the warning color says so)
      return autoPaused
        ? { text: '⏵⏵ auto mode paused · approve to resume', color: color.warning }
        : { text: '⏵⏵ auto mode on', color: color.auto }
    case 'acceptEdits':
      return { text: '⏵⏵ accept edits on', color: color.acceptEdits }
    case 'plan':
      return { text: '⏸ plan mode on', color: color.plan }
    case 'bypassPermissions':
      return { text: '⏵⏵ bypass permissions on', color: color.bypass }
    case 'dontAsk':
      return { text: "⏵⏵ don't ask on", color: color.warning }
    default:
      return { text: '⏸ manual mode on', color: color.dim }
  }
}

/** Dim hint after the mode text. */
export const CYCLE_HINT = ' (shift+tab to cycle)'

/** Below the prompt box: mode indicator on the left, model, thinking and context on the right. */
export function Footer(props: FooterProps): ReactElement {
  const { mode, model, thinking, contextLeftPct, costUsd, hint, shortcutsOpen, busy } = props
  const { vimMode, statusLine, tasks, sessionName, autoPaused } = props
  const inputEmpty = props.inputEmpty ?? true
  useTheme()
  const indicator = modeIndicator(mode, autoPaused === true)
  const low = contextLeftPct !== undefined && contextLeftPct <= 20
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box flexShrink={0}>
        {vimMode ? (
          <Text bold>{vimMode.startsWith('--') ? vimMode : `-- ${vimMode.toUpperCase()} --`} </Text>
        ) : null}
        {hint ? (
          <Text>{hint}</Text>
        ) : (
          <Text>
            <Text color={indicator.color}>{indicator.text}</Text>
            <Text dimColor>{CYCLE_HINT}</Text>
            {busy ? <Text dimColor> · esc to interrupt</Text> : null}
            {!busy && inputEmpty && !shortcutsOpen ? (
              <Text dimColor> · ? for shortcuts</Text>
            ) : null}
            {shortcutsOpen ? <Text dimColor> · ? to close shortcuts</Text> : null}
          </Text>
        )}
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

/** The three columns of the `?` panel, row by row (the reference TUI's list, what we support). */
export const SHORTCUT_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['! for bash mode', 'double tap esc to clear input', 'alt+p to switch model'],
  ['/ for commands', 'shift+tab to cycle modes', 'alt+t to change thinking'],
  ['@ for file paths', 'ctrl+o for transcript', 'ctrl+r to search history'],
  ['\\⏎ for newline', 'ctrl+t to show todos', 'ctrl+s to stash prompt'],
  ['ctrl+g to edit in $EDITOR', 'ctrl+v to paste images', 'esc to interrupt'],
]

/** The three-column shortcut list shown when `?` is pressed on an empty prompt. */
export function ShortcutsPanel(): ReactElement {
  const { columns } = useWindowSize()
  const width = Math.max(20, Math.floor((columns - 4) / 3))
  return (
    <Box flexDirection="column" paddingX={2}>
      {SHORTCUT_ROWS.map((row) => (
        <Box key={row[0]}>
          {row.map((cell) => (
            <Box key={cell} width={width} flexShrink={0}>
              <Text dimColor wrap="truncate-end">
                {cell}
              </Text>
            </Box>
          ))}
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
  inputEmpty?: boolean
}

/** A {@link Footer} that loads context and cost from the controller (kept for the App). */
export function StatusBar(props: StatusBarProps): ReactElement {
  const { controller, mode, model, running, statsVersion, hint, shortcutsOpen } = props
  const inputEmpty = props.inputEmpty ?? true
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
      inputEmpty={inputEmpty}
      busy={running}
    />
  )
}
