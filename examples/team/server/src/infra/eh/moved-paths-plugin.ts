/**
 * `movedPaths` plugin: the other half of the redirects of a reorganized library. The agents' file
 * system (`libraryFs` with `redirectMoves`) already reads and writes a moved file through its old
 * path; this hook makes the tool result SAY so, so the model switches to the new path and fixes its
 * own notes: "Moved: <old> → <new>" before a read, "Written to <new> (moved from <old>)" after a
 * write, "This folder moved to <new>" for a listing or a view of an old folder.
 * A safety net: the programs' authority and the references are rewritten by the import itself.
 */
import type { Database } from 'bun:sqlite'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { folderMovedNote, movedNote, writtenNote } from '../../domain/library-moves.ts'
import { movedFolderTarget, movedTarget } from './library-moves.ts'

const READS = /(?:^|_)(?:read_file|memory_view)$/
const WRITES = /(?:^|_)(?:write_file|edit_file|memory_create|memory_str_replace|memory_insert)$/
const LISTS = /(?:^|_)list_files$/

const failed = (text: string): boolean => /^(ERROR|CONFLICT|REJECTED)\b/.test(text)

const clean = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw === '') return undefined
  const path = `/${raw
    .split('/')
    .filter((p) => p !== '')
    .join('/')}`
  return path === '/' ? undefined : path
}

export function movedPaths(sqlite: Database): HarnessPlugin<'moved-paths'> {
  return definePlugin({
    name: 'moved-paths',
    setup: () => ({
      hooks: {
        'tool.after': (
          _ctx,
          e: { toolName: string; input: unknown; output: unknown },
        ): { output: unknown } | undefined => {
          if (typeof e.output !== 'string') return undefined
          const input = (e.input ?? {}) as Record<string, unknown>
          const output = e.output
          try {
            if (READS.test(e.toolName) || LISTS.test(e.toolName)) {
              const path = clean(LISTS.test(e.toolName) ? input.prefix : input.path)
              if (path === undefined) return undefined
              const target = READS.test(e.toolName) ? movedTarget(sqlite, path) : undefined
              if (target !== undefined && !failed(output)) {
                return { output: `${movedNote(path, target)}\n${output}` }
              }
              const folder = movedFolderTarget(sqlite, `${path}/`)
              return folder === undefined
                ? undefined
                : { output: `${folderMovedNote(`${path}/`, folder)}\n${output}` }
            }
            if (WRITES.test(e.toolName)) {
              const path = clean(input.path)
              if (path === undefined || failed(output)) return undefined
              const target = movedTarget(sqlite, path)
              if (target === undefined) return undefined
              return { output: `${writtenNote(path, target)}\n${output.split(path).join(target)}` }
            }
          } catch {
            // the note is a courtesy: a failed lookup never changes a tool result
          }
          return undefined
        },
      },
    }),
  })
}
