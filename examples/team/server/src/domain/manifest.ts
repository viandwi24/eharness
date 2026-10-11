/**
 * Work manifest (docs/plans/P40-team-autonomous-operations.md, decision D7.2/D7.4): the checkpoint
 * of a chunked job, `/library/work/<run>/manifest.json`. A run lists its chunks once; every chunk
 * is `pending`, `done` or `failed`; a run that stops (timeout, crash, compaction, the next day's
 * run) reads the manifest and carries on with the chunks that are not done. Pure functions over
 * the manifest value; the tools (infra) read and write the file.
 */
import { invalid } from './errors.ts'

export const WORK_ROOT = '/library/work'
export const MAX_CHUNKS = 2_000
/** A failed chunk is offered again until it has failed this many times. */
export const MAX_CHUNK_ATTEMPTS = 3

export type ChunkStatus = 'pending' | 'done' | 'failed'

export interface ManifestChunk {
  /** `^[A-Za-z0-9._-]{1,64}$`; also the name of its findings file. */
  id: string
  status: ChunkStatus
  /** Library files the chunk covers (what the agent reads for it). */
  paths: string[]
  /** What this chunk is, in a few words (for the agent reading `manifest_next`). */
  note?: string
  /** Library path of the structured result of this chunk, when done. */
  findings?: string
  /** Times it was marked failed. */
  attempts: number
  /** Why the last attempt failed. */
  error?: string
  updatedAt: number
}

export interface Manifest {
  version: 1
  run: string
  purpose?: string
  createdAt: number
  updatedAt: number
  /** Last chunk marked done (the cursor of what was processed). */
  cursor: { lastDone: string | null }
  chunks: ManifestChunk[]
}

export interface ChunkSpec {
  id: string
  paths?: string[] | undefined
  note?: string | undefined
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function checkRunId(run: string): void {
  if (!ID.test(run)) {
    throw invalid(
      'run id must be 1-64 characters of letters, digits, ".", "_" or "-" (for example community-audit-2026-10-11)',
      'INVALID_RUN',
    )
  }
}

export const manifestPath = (run: string): string => `${WORK_ROOT}/${run}/manifest.json`
export const findingsPath = (run: string, chunk: string): string =>
  `${WORK_ROOT}/${run}/findings/${chunk}.json`

/** A new manifest with every chunk pending. Throws `INVALID_MANIFEST` for a bad or duplicate id. */
export function createManifest(
  run: string,
  chunks: readonly ChunkSpec[],
  now: number,
  purpose?: string,
): Manifest {
  checkRunId(run)
  if (chunks.length === 0) throw invalid('a manifest needs at least one chunk', 'INVALID_MANIFEST')
  if (chunks.length > MAX_CHUNKS) {
    throw invalid(`a manifest has at most ${MAX_CHUNKS} chunks`, 'INVALID_MANIFEST')
  }
  const seen = new Set<string>()
  for (const c of chunks) {
    if (!ID.test(c.id)) throw invalid(`bad chunk id "${c.id}"`, 'INVALID_MANIFEST')
    if (seen.has(c.id)) throw invalid(`duplicate chunk id "${c.id}"`, 'INVALID_MANIFEST')
    seen.add(c.id)
  }
  return {
    version: 1,
    run,
    ...(purpose === undefined ? {} : { purpose }),
    createdAt: now,
    updatedAt: now,
    cursor: { lastDone: null },
    chunks: chunks.map((c) => ({
      id: c.id,
      status: 'pending' as const,
      paths: [...(c.paths ?? [])],
      ...(c.note === undefined ? {} : { note: c.note }),
      attempts: 0,
      updatedAt: now,
    })),
  }
}

export function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined
  try {
    const v = JSON.parse(text) as Manifest
    return v.version === 1 && Array.isArray(v.chunks) && typeof v.run === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

export interface Progress {
  total: number
  done: number
  pending: number
  /** Failed and still allowed another attempt. */
  retryable: number
  /** Failed for good (attempts used up). */
  exhausted: number
  lastDone: string | null
  complete: boolean
}

export function progressOf(m: Manifest): Progress {
  let done = 0
  let pending = 0
  let retryable = 0
  let exhausted = 0
  for (const c of m.chunks) {
    if (c.status === 'done') done++
    else if (c.status === 'pending') pending++
    else if (c.attempts < MAX_CHUNK_ATTEMPTS) retryable++
    else exhausted++
  }
  return {
    total: m.chunks.length,
    done,
    pending,
    retryable,
    exhausted,
    lastDone: m.cursor.lastDone,
    // nothing is left to do: every chunk is done or failed for good
    complete: pending === 0 && retryable === 0,
  }
}

/** The next chunks to work on: pending ones in order, then failed ones with attempts left. */
export function nextChunks(m: Manifest, limit: number): ManifestChunk[] {
  const pending = m.chunks.filter((c) => c.status === 'pending')
  const retry = m.chunks.filter((c) => c.status === 'failed' && c.attempts < MAX_CHUNK_ATTEMPTS)
  return [...pending, ...retry].slice(0, Math.max(1, limit))
}

export type MarkResult = { ok: true; manifest: Manifest } | { ok: false; error: string }

/** Mark one chunk. `done` records the findings path; `failed` counts an attempt. */
export function markChunk(
  m: Manifest,
  chunk: string,
  mark: { status: 'done' | 'failed'; findings?: string | undefined; error?: string | undefined },
  now: number,
): MarkResult {
  const i = m.chunks.findIndex((c) => c.id === chunk)
  if (i < 0) {
    return {
      ok: false,
      error: `chunk "${chunk}" is not in manifest ${m.run} (chunks: ${m.chunks
        .slice(0, 8)
        .map((c) => c.id)
        .join(', ')}${m.chunks.length > 8 ? ', ...' : ''})`,
    }
  }
  const cur = m.chunks[i] as ManifestChunk
  const next: ManifestChunk = { ...cur, status: mark.status, updatedAt: now }
  if (mark.status === 'done') {
    delete next.error
    if (mark.findings !== undefined) next.findings = mark.findings
  } else {
    next.attempts = cur.attempts + 1
    next.error = mark.error ?? 'failed'
  }
  const chunks = m.chunks.slice()
  chunks[i] = next
  return {
    ok: true,
    manifest: {
      ...m,
      updatedAt: now,
      cursor: { lastDone: mark.status === 'done' ? chunk : m.cursor.lastDone },
      chunks,
    },
  }
}
