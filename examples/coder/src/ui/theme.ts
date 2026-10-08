/**
 * Colors and symbols of the terminal UI, in one place ("classic coding-agent terminal style").
 * With `NO_COLOR` set every color is `undefined`, so Ink emits no color codes at all (bold, dim,
 * inverse and strikethrough still apply).
 */
import { useSyncExternalStore } from 'react'
import type { PermissionMode } from '../contracts.ts'

const plain = (): boolean => (process.env.NO_COLOR ?? '') !== ''

const DARK = {
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
}

type Palette = { [K in keyof typeof DARK]: string | undefined }

const LIGHT: typeof DARK = {
  accent: '#D97757',
  ok: '#1F7A3A',
  running: '#B07900',
  error: '#C62840',
  denied: '#C62840',
  warning: '#B07900',
  plan: '#2C6E65',
  acceptEdits: '#6B4FD8',
  bypass: '#C62840',
  shell: '#C21E7E',
  dim: '#5F5F5F',
  border: '#6E6E6E',
  text: '#1A1A1A',
  user: '#555555',
  userBg: '#E6E6E6',
  added: '#1F7A3A',
  removed: '#C62840',
  addedBg: '#D4F0DA',
  removedBg: '#F8D7DC',
  hunk: '#2C6E65',
  link: '#1F5FBF',
}

/** The theme names {@link setTheme} accepts. */
export type ThemeSetting = 'dark' | 'light' | 'auto'

/**
 * Ink color values (hex or color names); `undefined` under `NO_COLOR`. The object is mutated in
 * place by {@link setTheme}, so components must read `color.*` while rendering (never at module
 * load) and re-render after a switch (see {@link useTheme}).
 */
export const color: Palette = { ...DARK }

let current: 'dark' | 'light' = 'dark'
let currentSetting: ThemeSetting = 'dark'
let version = 0
const listeners = new Set<() => void>()

/** True when `COLORFGBG` (`fg;bg`) says the terminal background is light (bg 7 or 15). */
export function backgroundIsLight(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COLORFGBG
  if (!raw) return false
  const bg = raw.split(';').pop()?.trim()
  return bg === '15' || bg === '7'
}

/** Resolve a theme setting to a concrete palette name (`auto` follows `COLORFGBG`). */
export function resolveTheme(
  name: ThemeSetting,
  env: NodeJS.ProcessEnv = process.env,
): 'dark' | 'light' {
  if (name === 'auto') return backgroundIsLight(env) ? 'light' : 'dark'
  return name
}

/**
 * Switch the palette in place and notify {@link useTheme} subscribers (the App should call
 * `useTheme()` once near its root so the whole tree re-renders). `NO_COLOR` still wins.
 */
export function setTheme(name: ThemeSetting): void {
  currentSetting = name
  current = resolveTheme(name)
  const source = current === 'light' ? LIGHT : DARK
  const off = plain()
  for (const key of Object.keys(source) as Array<keyof typeof DARK>) {
    color[key] = off ? undefined : source[key]
  }
  version++
  for (const listener of [...listeners]) listener()
}

/** The effective palette (`auto` resolved): `dark` or `light`. */
export function themeName(): 'dark' | 'light' {
  return current
}

/** The setting last passed to {@link setTheme} (`auto` stays `auto`). */
export function themeSetting(): ThemeSetting {
  return currentSetting
}

/** Counter bumped by every {@link setTheme}. */
export function themeVersion(): number {
  return version
}

/** Subscribe to theme switches; returns the unsubscribe function. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * React hook: re-renders the calling component whenever {@link setTheme} runs and returns the
 * version counter. Call it once in the App (and in any memoized component reading `color`).
 */
export function useTheme(): number {
  return useSyncExternalStore(subscribeTheme, themeVersion, themeVersion)
}

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
