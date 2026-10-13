/** Library use cases: browse and edit the shared files (the agents' artifacts and uploads). */
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  assertLibraryPath,
  type LibraryFileMeta,
  type LibraryVersion,
  MAX_TEXT_BYTES,
  normalizeFilePath,
  normalizePrefix,
} from '../domain/library.ts'
import { MEMORY_ROOT } from '../domain/memory.ts'
import type { Deps, FileChange } from './ports.ts'

export interface LibraryEntry extends LibraryFileMeta {
  /** The agent that wrote the file last (every save sets it); null = a person (upload or editor). */
  createdBy: { id: string; name: string; slug: string } | null
}

export function creatorOf(deps: Deps, agentId: string | null): LibraryEntry['createdBy'] {
  if (agentId === null) return null
  const agent = deps.agents.get(agentId)
  return agent === undefined
    ? { id: agentId, name: agentId, slug: agentId }
    : {
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
      }
}

export const withCreator = (deps: Deps, meta: LibraryFileMeta): LibraryEntry => ({
  ...meta,
  createdBy: creatorOf(deps, meta.createdByAgentId),
})

export function listLibrary(
  deps: Deps,
  query: { prefix?: string; limit?: number },
): LibraryEntry[] {
  const prefix = normalizePrefix(query.prefix ?? '/')
  if (prefix === `${MEMORY_ROOT}/` || prefix.startsWith(`${MEMORY_ROOT}/`)) {
    throw invalid('memory files are served under /memory', 'INVALID_PATH')
  }
  return (
    deps.library
      // `/.eharness/` holds the library's own files (evicted tool outputs): not the client's documents
      .list({
        prefix,
        excludePrefixes: [
          `${MEMORY_ROOT}/`,
          ...(prefix.startsWith('/.eharness') ? [] : ['/.eharness/']),
        ],
        limit: query.limit ?? 500,
      })
      .map((m) => withCreator(deps, m))
  )
}

export async function readLibraryFile(deps: Deps, rawPath: string) {
  const path = normalizeFilePath(rawPath)
  assertLibraryPath(path)
  const file = await deps.library.read(path)
  if (file === undefined) throw notFound('file', path)
  return { entry: withCreator(deps, file.meta), text: file.text, bytes: file.bytes }
}

/** Turn a failed conditional change into the error the API reports (`details.currentVersion`). */
export function expectChanged(change: FileChange, path: string): string {
  if (change.ok) return change.version
  const details =
    change.currentVersion === undefined ? undefined : { currentVersion: change.currentVersion }
  if (change.reason === 'missing') throw notFound('file', path)
  if (change.reason === 'exists') {
    throw conflict(`a file already exists at ${path}`, 'FILE_EXISTS', details)
  }
  throw conflict(
    `${path} was changed since version you edited (an agent may have written it); reload and retry`,
    'VERSION_CONFLICT',
    details,
  )
}

export function checkText(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) {
    throw invalid(`text is larger than ${MAX_TEXT_BYTES} bytes`, 'FILE_TOO_LARGE')
  }
}

export async function writeLibraryFile(
  deps: Deps,
  rawPath: string,
  content: string,
  ifVersion?: string | null,
): Promise<{ path: string; version: string }> {
  const path = normalizeFilePath(rawPath)
  assertLibraryPath(path)
  checkText(content)
  const version = expectChanged(await deps.library.writeText(path, content, ifVersion), path)
  return { path, version }
}

export async function deleteLibraryFile(
  deps: Deps,
  rawPath: string,
  ifVersion?: string,
): Promise<{ path: string }> {
  const path = normalizeFilePath(rawPath)
  assertLibraryPath(path)
  expectChanged(await deps.library.delete(path, ifVersion), path)
  return { path }
}

export async function moveLibraryFile(
  deps: Deps,
  from: string,
  to: string,
  ifVersion?: string,
): Promise<{ from: string; to: string }> {
  const source = normalizeFilePath(from)
  const target = normalizeFilePath(to)
  assertLibraryPath(source)
  assertLibraryPath(target)
  if (source === target) throw invalid('source and destination are the same', 'INVALID_PATH')
  expectChanged(await deps.library.move(source, target, ifVersion), source)
  return { from: source, to: target }
}

export function libraryVersions(
  deps: Deps,
  rawPath: string,
  limit = 50,
): { path: string; versions: Array<LibraryVersion & { by: LibraryEntry['createdBy'] }> } {
  const path = normalizeFilePath(rawPath)
  assertLibraryPath(path)
  const versions = deps.library.versions(path, limit)
  return {
    path,
    versions: versions.map((v) => ({ ...v, by: creatorOf(deps, v.agentId) })),
  }
}
