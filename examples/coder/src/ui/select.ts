/**
 * Shared key handling of selectable lists, following the reference TUI's "Select" actions:
 * Down/J/Ctrl+N next, Up/K/Ctrl+P previous, PageUp/PageDown a page, Home/End first/last,
 * Enter accept, Esc cancel.
 */
import type { Key } from 'ink'

/** What a key means in a list. */
export type SelectAction =
  | 'next'
  | 'previous'
  | 'pageUp'
  | 'pageDown'
  | 'first'
  | 'last'
  | 'accept'
  | 'cancel'

/**
 * The list action of a key, or null. `letters: false` leaves `j`/`k` alone (lists that filter as
 * you type, where they are text).
 */
export function selectAction(
  input: string,
  key: Key,
  opts: { letters?: boolean } = {},
): SelectAction | null {
  const letters = opts.letters ?? true
  if (key.escape) return 'cancel'
  if (key.return) return 'accept'
  if (key.downArrow || (key.ctrl && input === 'n')) return 'next'
  if (key.upArrow || (key.ctrl && input === 'p')) return 'previous'
  if (key.pageUp) return 'pageUp'
  if (key.pageDown) return 'pageDown'
  if (key.home) return 'first'
  if (key.end) return 'last'
  if (letters && !key.ctrl && !key.meta) {
    if (input === 'j') return 'next'
    if (input === 'k') return 'previous'
  }
  return null
}

/** The index after a movement action (clamped, no wrap); other actions keep it. */
export function moveIndex(
  index: number,
  count: number,
  action: SelectAction | null,
  page = 8,
): number {
  if (count <= 0) return 0
  const clamp = (n: number): number => Math.max(0, Math.min(count - 1, n))
  switch (action) {
    case 'next':
      return clamp(index + 1)
    case 'previous':
      return clamp(index - 1)
    case 'pageDown':
      return clamp(index + page)
    case 'pageUp':
      return clamp(index - page)
    case 'first':
      return 0
    case 'last':
      return count - 1
    default:
      return clamp(index)
  }
}
