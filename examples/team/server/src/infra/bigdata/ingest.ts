/**
 * Ingest (decision D7.1): pull the new items of a collector into the library as hourly JSONL files.
 * Deterministic, no model. Safe to repeat and to crash in the middle: files are written before the
 * cursor moves, and an item already in a file (same id) is never added twice.
 */
import type { FileSystem } from 'eharness/filesystem'
import {
  type CollectedItem,
  type Collector,
  checkSourceId,
  cursorPath,
  groupByFile,
  mergeJsonl,
  parseCursor,
} from '../../domain/collectors.ts'

export interface IngestOptions {
  /** Pages to pull at most in one call (a collector with a long backlog is drained over calls). */
  maxPages?: number
  /** Items to pull at most in one call. */
  maxItems?: number
  now?: () => number
  signal?: AbortSignal
  /** May this path be written? (program authority); a refused path stops ingest with an error. */
  canWrite?: (path: string) => boolean
}

export interface IngestResult {
  source: string
  /** New items that were written. */
  added: number
  /** Items the collector delivered that were already in the files. */
  duplicates: number
  files: number
  channels: string[]
  /** Day range `YYYY-MM-DD` of the items written, or null. */
  firstDay: string | null
  lastDay: string | null
  /** Cursor after this call. */
  cursor: string | null
  /** The collector had nothing more at the end. */
  drained: boolean
  /** Items ever ingested for the source. */
  total: number
}

export class IngestRefused extends Error {}

const DEFAULT_MAX_PAGES = 50

async function statOf(fs: FileSystem, path: string): Promise<{ version: string } | null> {
  if (fs.stat !== undefined) return fs.stat(path)
  return fs.read(path)
}

async function writeText(fs: FileSystem, path: string, text: string): Promise<void> {
  // a few retries: another ingest (another instance) may write the same hour file
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await statOf(fs, path)
    const result = await fs.write(
      path,
      text,
      cur === null ? { ifVersion: null } : { ifVersion: cur.version },
    )
    if (result.ok) return
  }
  throw new Error(`could not write ${path}: it keeps changing`)
}

export async function ingestSource(
  fs: FileSystem,
  collector: Collector,
  options: IngestOptions = {},
): Promise<IngestResult> {
  checkSourceId(collector.id)
  const now = options.now ?? Date.now
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY
  const cursorFile = cursorPath(collector.id)
  const stored = parseCursor((await fs.read(cursorFile))?.content)
  let cursor = stored.cursor
  let total = stored.total

  const result: IngestResult = {
    source: collector.id,
    added: 0,
    duplicates: 0,
    files: 0,
    channels: [],
    firstDay: null,
    lastDay: null,
    cursor,
    drained: false,
    total,
  }
  const channels = new Set<string>()
  const files = new Set<string>()

  for (let page = 0; page < maxPages && result.added + result.duplicates < maxItems; page++) {
    options.signal?.throwIfAborted()
    const polled = await collector.poll(cursor, options.signal ? { signal: options.signal } : {})
    if (polled.items.length === 0) {
      result.drained = true
      break
    }
    const groups = groupByFile(collector.id, polled.items as CollectedItem[])
    for (const path of groups.keys()) {
      if (options.canWrite?.(path) === false) {
        throw new IngestRefused(
          `writing ${path} is outside the write authority of this run; nothing of this page was stored`,
        )
      }
    }
    let pageAdded = 0
    for (const [path, items] of groups) {
      const existing = (await fs.read(path))?.content
      const merged = mergeJsonl(existing, items)
      if (merged.added > 0) await writeText(fs, path, merged.text)
      result.duplicates += items.length - merged.added
      pageAdded += merged.added
      files.add(path)
      for (const item of items) channels.add(item.channel)
      const day = path.split('/').at(-2) as string
      if (merged.added > 0) {
        if (result.firstDay === null || day < result.firstDay) result.firstDay = day
        if (result.lastDay === null || day > result.lastDay) result.lastDay = day
      }
    }
    result.added += pageAdded
    total += pageAdded
    cursor = polled.cursor
    // the cursor moves only after the page's files are stored
    const body = JSON.stringify({ cursor, total, updatedAt: now() })
    if (options.canWrite?.(cursorFile) === false) {
      throw new IngestRefused(`writing ${cursorFile} is outside the write authority of this run`)
    }
    await writeText(fs, cursorFile, `${body}\n`)
  }
  result.cursor = cursor
  result.total = total
  result.files = files.size
  result.channels = [...channels].sort()
  return result
}

export function ingestSummary(r: IngestResult): string {
  if (r.added === 0 && r.duplicates === 0) {
    return `Nothing new from source ${r.source} (cursor ${r.cursor ?? 'start'}, ${r.total} items stored in all).`
  }
  return [
    `Ingested ${r.added} new items from source ${r.source} into ${r.files} files under /library/data/${r.source}/ (${r.channels.length} channels: ${r.channels.join(', ')}).`,
    r.firstDay === null
      ? ''
      : `Days: ${r.firstDay}${r.lastDay === r.firstDay ? '' : ` to ${r.lastDay}`}.`,
    r.duplicates > 0 ? `${r.duplicates} items were already stored.` : '',
    r.drained
      ? 'The source has nothing more for now.'
      : 'The source has more: call ingest_source again to continue.',
    `Stored in all: ${r.total} items. Layout: /library/data/${r.source}/<channel>/<YYYY-MM-DD>/<HH>.jsonl (one JSON item per line).`,
  ]
    .filter((l) => l !== '')
    .join(' ')
}
