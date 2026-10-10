/** Memory use cases: the same files the agents edit with their memory tools (ADR-0022). */
import { invalid, notFound } from '../domain/errors.ts'
import {
  agentMemory,
  type MemoryScope,
  normalizeMemoryPath,
  WORKSPACE_MEMORY,
} from '../domain/memory.ts'
import { getAgent } from './agents.ts'
import { checkText, expectChanged } from './library.ts'
import type { Deps } from './ports.ts'

export interface MemoryFileInfo {
  /** Relative to the scope root, e.g. `profile.md`. */
  path: string
  version: string
  size: number
  updatedAt: number
}

function rootOf(deps: Deps, scope: MemoryScope, agentId: string | undefined) {
  if (scope === 'workspace') return { root: WORKSPACE_MEMORY, agentId: null }
  if (agentId === undefined || agentId === '') {
    throw invalid('scope=agent needs agentId', 'INVALID_MEMORY_SCOPE')
  }
  const agent = getAgent(deps, agentId)
  return { root: agentMemory(agent.id), agentId: agent.id }
}

export function listMemory(
  deps: Deps,
  scope: MemoryScope,
  agentId?: string,
): { scope: MemoryScope; agentId: string | null; root: string; files: MemoryFileInfo[] } {
  const r = rootOf(deps, scope, agentId)
  const prefix = `${r.root}/`
  const files = deps.library.list({ prefix, limit: 1000 }).map((m) => ({
    path: m.path.slice(prefix.length),
    version: m.version,
    size: m.size,
    updatedAt: m.updatedAt,
  }))
  return { scope, agentId: r.agentId, root: r.root, files }
}

export async function readMemoryFile(
  deps: Deps,
  scope: MemoryScope,
  agentId: string | undefined,
  rawPath: string,
) {
  const r = rootOf(deps, scope, agentId)
  const path = normalizeMemoryPath(rawPath)
  const file = await deps.library.read(`${r.root}/${path}`)
  if (file === undefined) throw notFound('memory file', path)
  if (file.text === null) throw invalid('binary files are not memory', 'BINARY_FILE')
  return {
    scope,
    agentId: r.agentId,
    path,
    version: file.meta.version,
    size: file.meta.size,
    updatedAt: file.meta.updatedAt,
    content: file.text,
  }
}

export async function writeMemoryFile(
  deps: Deps,
  scope: MemoryScope,
  agentId: string | undefined,
  rawPath: string,
  content: string,
  ifVersion?: string | null,
): Promise<{ scope: MemoryScope; agentId: string | null; path: string; version: string }> {
  const r = rootOf(deps, scope, agentId)
  const path = normalizeMemoryPath(rawPath)
  checkText(content)
  const abs = `${r.root}/${path}`
  const version = expectChanged(await deps.library.writeText(abs, content, ifVersion), path)
  return { scope, agentId: r.agentId, path, version }
}

export async function deleteMemoryFile(
  deps: Deps,
  scope: MemoryScope,
  agentId: string | undefined,
  rawPath: string,
  ifVersion?: string,
): Promise<{ scope: MemoryScope; agentId: string | null; path: string }> {
  const r = rootOf(deps, scope, agentId)
  const path = normalizeMemoryPath(rawPath)
  expectChanged(await deps.library.delete(`${r.root}/${path}`, ifVersion), path)
  return { scope, agentId: r.agentId, path }
}
