/**
 * Memory files for `/memory` and the prompt: `<root>/AGENTS.md` (fallback `<root>/CLAUDE.md`),
 * the user memory `<userDir>/AGENTS.md`, nested `AGENTS.md` files, plus the `addDirectory` helper
 * of `/add-dir`.
 *
 * `app/project-memory.ts` only loads the project file; the integrator should also load
 * {@link loadUserMemory} and pass it into the session instructions (user memory first, static).
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import type { Workspace } from '../contracts.ts'
import { isInside } from '../workspace/dir-access.ts'
import { loadProjectMemory } from './project-memory.ts'

/** One entry of `CoderController.memoryFiles()`. */
export interface MemoryFile {
  /** Display path: project-relative (`AGENTS.md`) or `~/.coder/AGENTS.md`. */
  path: string
  real: string
  exists: boolean
  scope: 'project' | 'user'
}

async function exists(file: string): Promise<boolean> {
  return await stat(file).then(
    (s) => s.isFile(),
    () => false,
  )
}

/**
 * The memory files in load order: the user file, the project file (`AGENTS.md`, or `CLAUDE.md`
 * when there is no `AGENTS.md`; the first one is listed as missing when neither exists), then
 * nested `AGENTS.md` files (project-relative, existing). Missing user/project files are listed
 * with `exists: false` so `/memory` can offer to create them.
 */
export async function listMemoryFiles(opts: {
  root: string
  userDir: string
}): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const userFile = join(opts.userDir, 'AGENTS.md')
  out.push({
    path: '~/.coder/AGENTS.md',
    real: userFile,
    exists: await exists(userFile),
    scope: 'user',
  })
  const agents = join(opts.root, 'AGENTS.md')
  const claude = join(opts.root, 'CLAUDE.md')
  if (await exists(agents))
    out.push({ path: 'AGENTS.md', real: agents, exists: true, scope: 'project' })
  else if (await exists(claude))
    out.push({ path: 'CLAUDE.md', real: claude, exists: true, scope: 'project' })
  else out.push({ path: 'AGENTS.md', real: agents, exists: false, scope: 'project' })
  const { nested } = await loadProjectMemory(opts.root)
  for (const virtual of nested) {
    const path = virtual.slice(1)
    out.push({ path, real: join(opts.root, path), exists: true, scope: 'project' })
  }
  return out
}

/** Text of the user memory file, if it exists (capped at 40 000 characters). */
export async function loadUserMemory(userDir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(userDir, 'AGENTS.md'), 'utf8')
    if (text.trim() === '') return undefined
    return text.length > 40_000
      ? `${text.slice(0, 40_000)}\n\n[truncated: the user memory file is longer than 40000 characters]`
      : text
  } catch {
    return undefined
  }
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
