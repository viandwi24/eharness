/** Text helpers. Pure. */

/** True when `s` has a control character (C0, DEL) or a backslash: never valid in a path segment. */
export function hasControlOrBackslash(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}
