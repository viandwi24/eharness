/** `@path` mention completion over the workspace file list (pure helpers + a small cache). */
import type { Workspace } from '../contracts.ts'

const CACHE_MS = 10_000
const MAX_RESULTS = 8

/** The `@token` ending at the cursor, if any (`start` is the index of the `@`). */
export function mentionAt(
  text: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return undefined
  const query = match[1] as string
  return { start: cursor - query.length - 1, query }
}

/** Case-insensitive substring match of the path, shortest paths first, at most 8. */
export function matchPaths(paths: readonly string[], query: string): string[] {
  const q = query.toLowerCase()
  return paths
    .filter((p) => p.toLowerCase().includes(q))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_RESULTS)
}

/** What a mention completes to. */
export type MentionKind = 'file' | 'folder' | 'agent'

/** One `@` suggestion; `value` is what follows the `@`. */
export interface MentionItem {
  kind: MentionKind
  value: string
}

/** Directory prefixes of the file list (`src/ui/` for `src/ui/a.ts`), each with a trailing `/`. */
export function folderPaths(paths: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const p of paths) {
    let at = p.indexOf('/')
    while (at !== -1) {
      folders.add(p.slice(0, at + 1))
      at = p.indexOf('/', at + 1)
    }
  }
  return [...folders]
}

/** Files, folders and agents (`@agent-<name>`) matching the query, shortest first, at most 8. */
export function matchMentions(
  paths: readonly string[],
  query: string,
  agents: readonly string[] = [],
  folders: readonly string[] = folderPaths(paths),
): MentionItem[] {
  const q = query.toLowerCase()
  const items: MentionItem[] = [
    ...paths.map((value): MentionItem => ({ kind: 'file', value })),
    ...folders.map((value): MentionItem => ({ kind: 'folder', value })),
    ...agents.map((name): MentionItem => ({ kind: 'agent', value: `agent-${name}` })),
  ]
  return items
    .filter((i) => i.value.toLowerCase().includes(q))
    .sort((a, b) => a.value.length - b.value.length || a.value.localeCompare(b.value))
    .slice(0, MAX_RESULTS)
}

/** Replace the `@token` with the chosen item; a folder gets no trailing space so the user can drill in. */
export function completeItem(
  text: string,
  start: number,
  cursor: number,
  item: MentionItem,
): { text: string; cursor: number } {
  if (item.kind !== 'folder') return completeMention(text, start, cursor, item.value)
  const insertion = `@${item.value}`
  return {
    text: text.slice(0, start) + insertion + text.slice(cursor),
    cursor: start + insertion.length,
  }
}

/** Replace the `@token` at `start`..`cursor` with `@<path> `. */
export function completeMention(
  text: string,
  start: number,
  cursor: number,
  path: string,
): { text: string; cursor: number } {
  const insertion = `@${path} `
  return {
    text: text.slice(0, start) + insertion + text.slice(cursor),
    cursor: start + insertion.length,
  }
}

/** Workspace file list (virtual paths without the leading `/`), cached for 10 s. */
export function createFileLister(workspace: Workspace): () => Promise<string[]> {
  let cached: { at: number; paths: string[] } | undefined
  let inflight: Promise<string[]> | undefined
  return async () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.paths
    inflight ??= workspace.fs
      .list('/')
      .then((files) => {
        const paths = files.map((f) => f.path.replace(/^\/+/, ''))
        cached = { at: Date.now(), paths }
        return paths
      })
      .catch(() => cached?.paths ?? [])
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }
}
