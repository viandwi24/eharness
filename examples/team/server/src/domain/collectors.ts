/**
 * Collectors (docs/plans/P40-team-autonomous-operations.md, decision D7.1): the pluggable source of
 * a big stream of items (chat messages, tickets, log lines). A collector only knows how to ask
 * "what is new since this cursor"; ingest (infra) appends the answer to the library as hourly JSONL
 * files, deterministically and without a model:
 *
 *   /library/data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl      (UTC)
 *
 * Pure: the interface, the paths and the merge of new items into an hour file.
 */
import { invalid } from './errors.ts'

/** One collected item. `id` is unique within the source (ingest dedupes by it), `at` is epoch ms. */
export interface CollectedItem {
  id: string
  channel: string
  at: number
  /** Everything else is the source's own shape (author, text, kind, ...). */
  [key: string]: unknown
}

export interface PollResult {
  /** New items after the cursor, in any order. Empty = nothing more for now. */
  items: CollectedItem[]
  /** Pass this to the next `poll`. `null` = start from the beginning. */
  cursor: string | null
}

export interface PollOptions {
  /** Upper bound of one page (the collector may return fewer). */
  limit?: number
  signal?: AbortSignal
}

/** A source of items. A Telegram or Slack MCP source is one implementation of this. */
export interface Collector {
  /** The source id: the directory under `/library/data` (`^[a-z0-9][a-z0-9-]{0,39}$`). */
  id: string
  description?: string
  /** Items after `cursor` (null = from the start). Must be repeatable: the same cursor, the same page. */
  poll(cursor: string | null, options?: PollOptions): Promise<PollResult>
}

/** Root of collected data inside the library. */
export const DATA_ROOT = '/library/data'

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

export function checkSourceId(id: string): void {
  if (!SOURCE_ID.test(id)) {
    throw invalid(`source id must match ${SOURCE_ID}`, 'INVALID_SOURCE')
  }
}

/** A channel name as one safe path segment (lower case, `[a-z0-9._-]`, never empty or dotted). */
export function channelSegment(channel: string): string {
  const s = channel
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
  return s === '' ? 'unknown' : s
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `/library/data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl` of an item (UTC). */
export function itemPath(source: string, item: Pick<CollectedItem, 'channel' | 'at'>): string {
  const d = new Date(item.at)
  const day = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
  return `${DATA_ROOT}/${source}/${channelSegment(item.channel)}/${day}/${two(d.getUTCHours())}.jsonl`
}

/** Where the cursor of a source lives (a library file, so it is versioned and visible). */
export const cursorPath = (source: string): string => `${DATA_ROOT}/${source}/_cursor.json`

/** The directory of a source: the write authority ingest needs is `<this>**`. */
export const sourcePrefix = (source: string): string => `${DATA_ROOT}/${source}/`

export interface StoredCursor {
  cursor: string | null
  /** Items ingested over the lifetime of this source. */
  total: number
  updatedAt: number
}

export function parseCursor(text: string | undefined): StoredCursor {
  if (text === undefined) return { cursor: null, total: 0, updatedAt: 0 }
  try {
    const v = JSON.parse(text) as Partial<StoredCursor>
    return {
      cursor: typeof v.cursor === 'string' ? v.cursor : null,
      total: typeof v.total === 'number' ? v.total : 0,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    }
  } catch {
    return { cursor: null, total: 0, updatedAt: 0 }
  }
}

/** Items grouped by the hour file they belong to, each group sorted by time then id. */
export function groupByFile(
  source: string,
  items: readonly CollectedItem[],
): Map<string, CollectedItem[]> {
  const out = new Map<string, CollectedItem[]>()
  for (const item of items) {
    const path = itemPath(source, item)
    const list = out.get(path)
    if (list === undefined) out.set(path, [item])
    else list.push(item)
  }
  for (const list of out.values()) list.sort(byTimeThenId)
  return out
}

export const byTimeThenId = (a: CollectedItem, b: CollectedItem): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The text of an hour file after adding `items`: lines already in the file are kept, an item whose
 * id is already there is skipped (ingest is at-least-once: a crash between the file and the cursor
 * re-delivers a page), the whole file stays sorted by time then id.
 */
export function mergeJsonl(
  existing: string | undefined,
  items: readonly CollectedItem[],
): { text: string; added: number } {
  const rows: CollectedItem[] = []
  const seen = new Set<string>()
  for (const line of (existing ?? '').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as CollectedItem
      if (typeof row.id === 'string') seen.add(row.id)
      rows.push(row)
    } catch {
      // a damaged line is dropped; the source can re-deliver it
    }
  }
  let added = 0
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    rows.push(item)
    added++
  }
  rows.sort(byTimeThenId)
  return { text: `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, added }
}
