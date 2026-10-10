/** Library and upload path conventions. Pure. */
import { invalid } from './errors.ts'
import { MEMORY_ROOT } from './memory.ts'
import { hasControlOrBackslash } from './text.ts'

export const LIBRARY_ROOT = '/library'
export const UPLOADS_ROOT = '/uploads'

export interface LibraryFileMeta {
  path: string
  version: string
  size: number
  mediaType: string | null
  binary: boolean
  createdByAgentId: string | null
  updatedAt: number
}

export interface LibraryVersion {
  seq: number
  action: 'write' | 'delete' | 'move'
  version: string | null
  size: number | null
  /** For a move: where the file came from. */
  fromPath: string | null
  /** The agent that made the change; null = a person. */
  agentId: string | null
  at: number
}

/** Largest text a person writes through the API. */
export const MAX_TEXT_BYTES = 1_000_000

export type FileArea = 'library' | 'upload' | 'memory'

export function areaOf(path: string): FileArea {
  if (path === MEMORY_ROOT || path.startsWith(`${MEMORY_ROOT}/`)) return 'memory'
  if (path.startsWith(`${UPLOADS_ROOT}/`)) return 'upload'
  return 'library'
}

/** A normalized absolute file path: no `..`, no empty or control segments, bounded. */
export function normalizeFilePath(raw: string): string {
  if (!raw.startsWith('/') || raw.length > 512 || raw.endsWith('/')) {
    throw invalid('path must be absolute, at most 512 characters, and name a file', 'INVALID_PATH')
  }
  const segments = raw.split('/').slice(1)
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || hasControlOrBackslash(s)) {
      throw invalid(`invalid path segment in ${raw}`, 'INVALID_PATH')
    }
  }
  return `/${segments.join('/')}`
}

/** A directory prefix: absolute, normalized, with a trailing slash (`/` = everything). */
export function normalizePrefix(raw: string): string {
  if (raw === '' || raw === '/') return '/'
  const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
  return `${normalizeFilePath(path)}/`
}

/** The library API never touches memory files (they have their own routes). */
export function assertLibraryPath(path: string): void {
  if (areaOf(path) === 'memory') {
    throw invalid('memory files are served under /memory', 'INVALID_PATH')
  }
}
