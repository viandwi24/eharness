/** Memory scopes are path conventions on the file store (plan §6.3, ADR-0022). Pure. */
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
