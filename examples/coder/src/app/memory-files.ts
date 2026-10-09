/**
 * Memory files for `/memory` and the prompt. Project instructions are loaded by the library
 * (`projectInstructions()` of `eharness/filesystem`: per directory `CLAUDE.md` wins over
 * `AGENTS.md`); this module lists them for `/memory`, loads the user memory
 * (`<userDir>/CLAUDE.md`, else `<userDir>/AGENTS.md`) and holds the `addDirectory` helper of
 * `/add-dir`.
 */
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import {
  type FileSystem,
  loadProjectInstructions,
  type ProjectInstructionsOptions,
} from 'eharness/filesystem'
import { diskFs } from 'eharness/filesystem/node'
import type { Workspace } from '../contracts.ts'
import { isInside } from '../workspace/dir-access.ts'

/** Options of the library's project instructions: the extra directories are not the project. */
export const PROJECT_INSTRUCTIONS_OPTIONS: ProjectInstructionsOptions = {
  exclude: ['/@dirs'],
}

/** One entry of `CoderController.memoryFiles()`. */
export interface MemoryFile {
  /** Display path: project-relative (`AGENTS.md`) or `~/.coder/AGENTS.md`. */
  path: string
  real: string
  exists: boolean
  scope: 'project' | 'user'
  /** Files in the same directory that exist but are not loaded (e.g. `AGENTS.md` next to `CLAUDE.md`). */
  ignored?: string[]
}

async function exists(file: string): Promise<boolean> {
  return await stat(file).then(
    (s) => s.isFile(),
    () => false,
  )
}

/**
 * The memory files in load order: the user file, the project root file, then nested files
 * (project-relative, existing). Per directory the library's preference applies (`CLAUDE.md`
 * before `AGENTS.md`); the loser is reported in `ignored`. A missing user/project file is listed
 * with `exists: false` (as `AGENTS.md`) so `/memory` can offer to create it.
 */
export async function listMemoryFiles(opts: {
  fs: FileSystem
  root: string
  userDir: string
}): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const user = await loadUserMemory(opts.userDir)
  const userName = user?.name ?? 'AGENTS.md'
  out.push({
    path: `~/.coder/${userName}`,
    real: join(opts.userDir, userName),
    exists: user !== undefined || (await exists(join(opts.userDir, userName))),
    scope: 'user',
    ...(user !== undefined && user.ignored.length > 0 ? { ignored: user.ignored } : {}),
  })
  const info = await loadProjectInstructions(opts.fs, PROJECT_INSTRUCTIONS_OPTIONS)
  if (info.root !== undefined) {
    out.push({
      path: info.root.name,
      real: join(opts.root, info.root.name),
      exists: true,
      scope: 'project',
      ...(info.root.ignored.length > 0 ? { ignored: info.root.ignored } : {}),
    })
  } else {
    out.push({
      path: 'AGENTS.md',
      real: join(opts.root, 'AGENTS.md'),
      exists: false,
      scope: 'project',
    })
  }
  for (const file of info.nested) {
    const path = file.path.slice(1)
    out.push({
      path,
      real: join(opts.root, path),
      exists: true,
      scope: 'project',
      ...(file.ignored.length > 0 ? { ignored: file.ignored } : {}),
    })
  }
  return out
}

/**
 * The user memory file of `userDir`: `CLAUDE.md`, else `AGENTS.md` (same preference as the
 * project), capped at 40 000 characters. Undefined when neither exists or the text is blank.
 */
export async function loadUserMemory(
  userDir: string,
): Promise<{ name: string; text: string; ignored: string[] } | undefined> {
  const info = await loadProjectInstructions(diskFs(userDir), { nested: false }).catch(
    () => undefined,
  )
  const root = info?.root
  if (root === undefined || root.content.trim() === '') return undefined
  return { name: root.name, text: root.content, ignored: root.ignored }
}

/**
 * Mount an extra directory: `~` is expanded, the path must be absolute (or `~/…`), exist, be a
 * directory and not be too broad (the filesystem root, the home directory, or the project or a
 * parent of it), the same checks as `request_directory_access`. Returns the virtual prefix.
 * Throws an `Error` with a user-readable message.
 */
export async function addDirectory(workspace: Workspace, path: string): Promise<string> {
  const trimmed = path.trim()
  if (trimmed === '') throw new Error('Give a directory path.')
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed
  if (!isAbsolute(expanded)) throw new Error(`The path must be absolute or start with ~/: ${path}`)
  const real = await realpath(resolve(expanded)).catch(() => null)
  if (real === null) throw new Error(`No such directory: ${path}`)
  if (!(await stat(real)).isDirectory()) throw new Error(`Not a directory: ${real}`)
  const root = workspace.mounts().find((m) => m.virtual === '/')?.real
  const home = await realpath(homedir()).catch(() => homedir())
  const tooBroad =
    real === parse(real).root || real === home || (root !== undefined && isInside(root, real))
  if (tooBroad) {
    throw new Error(
      `${real} is too broad (the filesystem root, your home directory, or the project or a parent of it).`,
    )
  }
  return await workspace.addDirectory(real)
}
