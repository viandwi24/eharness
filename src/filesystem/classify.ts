/**
 * Result prefixes of the file tools (spec 08 §3) and their classifier for UIs.
 *
 * @see docs/specs/08-filesystem-plugin.md#3-tools
 */

/** Kind of a file tool result, derived from its prefix. */
export type FileToolResultKind = 'ok' | 'error' | 'stale' | 'conflict' | 'rejected'

const PREFIXES: ReadonlyArray<[string, FileToolResultKind]> = [
  ['ERROR:', 'error'],
  ['STALE:', 'stale'],
  ['CONFLICT:', 'conflict'],
  ['REJECTED:', 'rejected'],
]

/**
 * Classify a file tool result by its prefix: `ERROR:` (invalid input, not found), `STALE:` (the
 * file changed since the last read; the current content follows), `CONFLICT:` (concurrent write
 * detected via `ifVersion`), `REJECTED:` (policy: read-only, hidden, undeletable, extension).
 * Anything else, including non-string outputs, is `'ok'`.
 *
 * @example
 * ```ts
 * classifyToolResult('STALE: /a.md changed since you last read it. …') // 'stale'
 * ```
 * @see docs/specs/08-filesystem-plugin.md#3-tools
 */
export function classifyToolResult(text: unknown): FileToolResultKind {
  if (typeof text !== 'string') return 'ok'
  for (const [prefix, kind] of PREFIXES) if (text.startsWith(prefix)) return kind
  return 'ok'
}
