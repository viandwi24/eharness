/** Ctrl+R reverse history search: pure matching helpers and the one-line view. */
import { Text } from 'ink'
import type { ReactElement } from 'react'
import { color } from './theme.ts'

/** Entries containing `query` (case-insensitive), newest first, without duplicates. */
export function searchMatches(pool: readonly string[], query: string): string[] {
  const needle = query.toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = pool.length - 1; i >= 0; i--) {
    const entry = pool[i] as string
    if (seen.has(entry)) continue
    if (needle === '' || entry.toLowerCase().includes(needle)) {
      seen.add(entry)
      out.push(entry)
    }
  }
  return out
}

/** Split a match around the first occurrence of the query (newlines shown as `↵`). */
export function splitMatch(
  text: string,
  query: string,
): { before: string; match: string; after: string } {
  const flat = text.replace(/\n/g, '↵')
  const at = query === '' ? -1 : flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return { before: flat, match: '', after: '' }
  return {
    before: flat.slice(0, at),
    match: flat.slice(at, at + query.length),
    after: flat.slice(at + query.length),
  }
}

/** `(reverse-i-search) 'query': match`, the matched substring highlighted. */
export function HistorySearch({
  query,
  match,
}: {
  query: string
  match: string | undefined
}): ReactElement {
  const parts = match === undefined ? undefined : splitMatch(match, query)
  return (
    <Text wrap="truncate-end">
      <Text dimColor>
        {'  '}({match === undefined ? 'failing ' : ''}reverse-i-search) '{query}':{' '}
      </Text>
      {parts ? (
        <>
          <Text>{parts.before}</Text>
          <Text color={color.accent} bold inverse>
            {parts.match}
          </Text>
          <Text>{parts.after}</Text>
        </>
      ) : null}
    </Text>
  )
}
