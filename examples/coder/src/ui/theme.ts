/**
 * Colors and symbols of the terminal UI, in one place ("classic coding-agent terminal style").
 * With `NO_COLOR` set every color is `undefined`, so Ink emits no color codes at all (bold, dim,
 * inverse and strikethrough still apply).
 */
import type { PermissionMode } from '../contracts.ts'

const plain = (): boolean => (process.env.NO_COLOR ?? '') !== ''

function palette<T extends Record<string, string>>(
  colors: T,
): { [K in keyof T]: string | undefined } {
  const off = plain()
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(colors)) out[key] = off ? undefined : value
  return out as { [K in keyof T]: string | undefined }
}

/** Ink color values (hex or color names); `undefined` under `NO_COLOR`. */
export const color = palette({
  accent: '#D97757',
  ok: '#4EBA65',
  running: '#FFC107',
  error: '#FF6B80',
  denied: '#FF6B80',
  warning: '#FFC107',
  plan: '#48968C',
  acceptEdits: '#AF87FF',
  bypass: '#FF6B80',
  shell: '#FD5DB1',
  dim: '#888888',
  /** Prompt box border when unfocused. */
  border: '#888888',
  text: '#FFFFFF',
  user: '#999999',
  userBg: '#373737',
  added: '#4EBA65',
  removed: '#FF6B80',
  addedBg: '#1E4D2B',
  removedBg: '#5A1F28',
  hunk: '#48968C',
  link: '#6CA6F0',
})

/** Symbols. */
export const sym = {
  bullet: '⏺',
  prompt: '>',
  branch: '⎿',
  star: '✻',
  pointer: '❯',
  minus: '−',
  ellipsis: '…',
  arrow: '↳',
  down: '↓',
  todo: { pending: '☐', in_progress: '◼', completed: '☒', cancelled: '☒' },
  /** Frames of the thinking glyph. */
  spinner: ['·', '✢', '✳', '✶', '✻', '✽'],
} as const

/** Color of a permission mode in the footer. */
export function modeColor(mode: PermissionMode): string | undefined {
  switch (mode) {
    case 'plan':
      return color.plan
    case 'acceptEdits':
      return color.acceptEdits
    case 'bypassPermissions':
      return color.bypass
    case 'dontAsk':
      return color.warning
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
