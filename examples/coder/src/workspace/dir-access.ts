/** The `request_directory_access` tool: mount a directory outside the project (after approval). */
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod/v4'
import type { Workspace } from '../contracts.ts'

/**
 * Build the `request_directory_access` tool. Approval is enforced by the permissions plugin
 * (`risk: 'external'`); this only resolves the path and mounts it.
 *
 * @param workspace The workspace to mount the directory into.
 */
export function createDirAccessTool(workspace: Workspace): ReturnType<typeof makeDirAccessTool> {
  return makeDirAccessTool(workspace)
}

function makeDirAccessTool(workspace: Workspace) {
  return tool({
    description:
      'Ask the user for access to a directory outside the project. Give an absolute path or ~/…, and the reason. On approval the directory is mounted and its virtual prefix is returned.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Absolute path or ~/… of the directory.'),
      reason: z.string().min(1).describe('Why the access is needed.'),
    }),
    metadata: { risk: 'external' },
    execute: async ({ path }): Promise<string> => {
      try {
        const expanded =
          path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
        if (!isAbsolute(expanded))
          return `ERROR: the path must be absolute or start with ~/: ${path}`
        const real = await realpath(resolve(expanded)).catch(() => null)
        if (real === null) return `ERROR: no such directory: ${path}`
        if (!(await stat(real)).isDirectory()) return `ERROR: not a directory: ${real}`
        const virtual = await workspace.addDirectory(real)
        return `Mounted ${real} at ${virtual}. Use that prefix with the file tools.`
      } catch (error) {
        return `ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
