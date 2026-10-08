/** Colors and symbols of the terminal UI, in one place. */
import type { PermissionMode } from '../contracts.ts'

/** Ink color names. */
export const color = {
  ok: 'green',
  running: 'yellow',
  error: 'red',
  denied: 'red',
  accent: 'cyan',
  user: 'blue',
  added: 'green',
  removed: 'red',
  hunk: 'cyan',
} as const

/** Symbols. */
export const sym = {
  bullet: '●',
  prompt: '>',
  branch: '⎿',
  todo: { pending: '☐', in_progress: '◐', completed: '☑', cancelled: '☒' },
  minus: '−',
  ellipsis: '…',
  pointer: '❯',
} as const

/** Color of a permission mode in the status bar. */
export function modeColor(mode: PermissionMode): string | undefined {
  switch (mode) {
    case 'plan':
      return 'cyan'
    case 'acceptEdits':
      return 'magenta'
    case 'bypassPermissions':
      return 'red'
    case 'dontAsk':
      return 'yellow'
    default:
      return undefined
  }
}

/** Human label of a permission mode. */
export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept edits'
    case 'bypassPermissions':
      return 'bypass permissions'
    case 'dontAsk':
      return "don't ask"
    default:
      return mode
  }
}
