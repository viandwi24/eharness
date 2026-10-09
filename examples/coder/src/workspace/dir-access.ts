/** The `request_directory_access` tool: mount a directory outside the project (after approval). */
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod/v4'
import type { Workspace } from '../contracts.ts'

/** True when `path` is `dir` or lies below it (both real, absolute paths). */
export const isInside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

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
        const root = workspace.mounts().find((m) => m.virtual === '/')?.real
        const tooBroad =
          real === parse(real).root ||
          real === (await realpath(homedir()).catch(() => homedir())) ||
          (root !== undefined && isInside(root, real))
        if (tooBroad) {
          return `ERROR: ${real} is too broad (it is the filesystem root, your home directory, or contains the project). Ask for a narrower directory.`
        }
        const virtual = await workspace.addDirectory(real)
        const note =
          real === resolve(expanded)
            ? ''
            : ` (requested ${path}, which resolves through a symlink to ${real})`
        return `Mounted ${real}${note} at ${virtual} (writable). Use that prefix with the file tools.`
      } catch (error) {
        return `ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
