/** Memory scopes are path conventions on the file store (plan §6.3, ADR-0022). Pure. */
import { invalid } from './errors.ts'
import { hasControlOrBackslash } from './text.ts'

export const MEMORY_ROOT = '/memories'
export const WORKSPACE_MEMORY = `${MEMORY_ROOT}/workspace`
export const agentMemory = (agentId: string): string => `${MEMORY_ROOT}/agents/${agentId}`

/** Memory roots of one agent: workspace memory (writable for the lead) and its own. */
export function memoryRootsFor(agent: { id: string; role: string }): Array<{
  path: string
  write: boolean
  label: string
}> {
  return [
    { path: WORKSPACE_MEMORY, write: agent.role === 'lead', label: 'workspace memory (shared)' },
    { path: agentMemory(agent.id), write: true, label: 'your own memory' },
  ]
}

/** Pinned files shown in the reminder every turn. */
export const pinnedMemoryFiles = (agentId: string): string[] => [
  `${WORKSPACE_MEMORY}/profile.md`,
  `${agentMemory(agentId)}/profile.md`,
]

export type MemoryScope = 'workspace' | 'agent'

/** A path relative to a memory root: no `..`, no leading slash, bounded. */
export function normalizeMemoryPath(raw: string): string {
  const clean = raw.replace(/^\/+/, '')
  const parts = clean.split('/')
  const bad = parts.some((s) => s === '' || s === '.' || s === '..' || hasControlOrBackslash(s))
  if (clean === '' || clean.length > 300 || bad) {
    throw invalid(`invalid memory path: ${raw}`, 'INVALID_PATH')
  }
  return clean
}
