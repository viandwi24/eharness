/**
 * Working-tree changes for the `/diff` page: `git status` + `git diff` against HEAD, untracked
 * files as additions, and the files the agent edited (`data-filesystem.change` parts). Outside a
 * git repository only the agent's edits are listed, with their current content as additions.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { CoderMessage, DiffFile, DiffResult } from '../contracts.ts'

const MAX_FILE_BYTES = 200 * 1024
const GIT_TIMEOUT_MS = 15_000
const MAX_FILES = 300
const CONCURRENCY = 8

interface GitResult {
  ok: boolean
  out: string
}

async function git(root: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.quotepath=false', ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS)
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    clearTimeout(timer)
    return { ok: code === 0, out }
  } catch {
    return { ok: false, out: '' }
  }
}

/** Root-relative paths of the files the agent changed in these messages (virtual path mapped by `toRoot`). */
export function agentEditedPaths(
  messages: readonly CoderMessage[],
  toRoot: (virtualPath: string) => string | null,
): Map<string, 'create' | 'write' | 'edit' | 'delete'> {
  const out = new Map<string, 'create' | 'write' | 'edit' | 'delete'>()
  for (const message of messages) {
    for (const part of message.parts) {
      if ((part.type as string) !== 'data-filesystem.change') continue
      const data = (part as { data?: { path?: unknown; action?: unknown } }).data
      if (typeof data?.path !== 'string') continue
      const rel = toRoot(data.path)
      if (rel === null) continue
      out.set(rel, data.action as 'create' | 'write' | 'edit' | 'delete')
    }
  }
  return out
}

function cap(text: string): string {
  return text.length <= MAX_FILE_BYTES
    ? text
    : `${text.slice(0, MAX_FILE_BYTES)}\n… [truncated: diff larger than ${MAX_FILE_BYTES / 1024} KB]\n`
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** An added file read from disk: full-file patch, binary files without one. */
async function addedFile(
  root: string,
  path: string,
  status: DiffFile['status'],
  editedByAgent: boolean,
): Promise<DiffFile> {
  const base: DiffFile = {
    path,
    status,
    added: 0,
    removed: 0,
    patch: '',
    binary: false,
    editedByAgent,
  }
  try {
    const info = await stat(join(root, path))
    if (!info.isFile()) return base
    const bytes = await readFile(join(root, path))
    if (bytes.subarray(0, 8000).includes(0)) return { ...base, binary: true }
    const text = new TextDecoder().decode(bytes)
    const shown = text.slice(0, MAX_FILE_BYTES)
    return {
      ...base,
      added: lineCount(text),
      patch: cap(createTwoFilesPatch('/dev/null', `b/${path}`, '', shown, '', '')),
    }
  } catch {
    return base
  }
}

function statusOf(xy: string): DiffFile['status'] {
  const [x, y] = [xy[0] ?? ' ', xy[1] ?? ' ']
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'R' || x === 'C') return 'renamed'
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i] as T)
      }
    }),
  )
  return out
}

/**
 * Compute the diff of the project at `root`.
 *
 * @param opts.messages - Messages of the session (edited-by-agent detection).
 * @param opts.toRoot - Virtual path to a root-relative path, `null` outside the root.
 */
export async function computeDiff(opts: {
  root: string
  messages: readonly CoderMessage[]
  toRoot: (virtualPath: string) => string | null
}): Promise<DiffResult> {
  const { root } = opts
  const edited = agentEditedPaths(opts.messages, opts.toRoot)
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') {
    const files = await pool([...edited.entries()], async ([path, action]) => {
      if (action === 'delete') {
        return {
          path,
          status: 'deleted',
          added: 0,
          removed: 0,
          patch: '',
          binary: false,
          editedByAgent: true,
        } satisfies DiffFile
      }
      return addedFile(root, path, 'added', true)
    })
    return { git: false, files }
  }

  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).out.trim()
  const branch =
    (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim() ||
    (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim() ||
    undefined
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok
  const base = hasHead
    ? 'HEAD'
    : (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).out.trim()

  const status = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ])
  const tokens = status.out.split('\0')
  const entries: Array<{ xy: string; path: string; from?: string }> = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token.length < 4) continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') entries.push({ xy, path, from: tokens[++i] ?? '' })
    else entries.push({ xy, path })
  }
  // `git status` paths are relative to the repository top, the project root may be a subdirectory
  const rel = (path: string): string | undefined =>
    path.startsWith(prefix) ? path.slice(prefix.length) : undefined
  const spec = (path: string): string => `:(top,literal)${path}`

  const files = await pool(
    entries.slice(0, MAX_FILES),
    async (entry): Promise<DiffFile | undefined> => {
      const path = rel(entry.path)
      if (path === undefined || path === '') return undefined
      const editedByAgent = edited.has(path)
      const status = statusOf(entry.xy)
      if (status === 'untracked') return addedFile(root, path, status, editedByAgent)
      const paths = entry.from !== undefined ? [entry.from, entry.path] : [entry.path]
      const specs = paths.map(spec)
      const numstat = await git(root, ['diff', base, '--numstat', '-M', '--', ...specs])
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(numstat.out)
      const binary = m?.[1] === '-'
      const patchResult = binary
        ? { out: '' }
        : await git(root, ['diff', base, '-M', '--', ...specs])
      return {
        path,
        status,
        added: m && !binary ? Number(m[1]) : 0,
        removed: m && !binary ? Number(m[2]) : 0,
        patch: cap(patchResult.out),
        binary,
        editedByAgent,
      }
    },
  )
  return {
    git: true,
    ...(branch ? { branch } : {}),
    files: files.filter((f): f is DiffFile => f !== undefined),
  }
}
