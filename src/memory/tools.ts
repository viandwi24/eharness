/**
 * The six memory tools (spec 14 §2): thin AI SDK tools over one {@link MemoryExecutor}.
 *
 * @see docs/specs/14-memory-plugin.md#2-commands-and-tools
 */
import { type Tool, tool } from 'ai'
import { z } from 'zod/v4'
import type { MemoryCommand } from './execute.ts'

/** Names of the memory tools, in their (stable) registration order. */
export const MEMORY_TOOLS: readonly [
  'memory_view',
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
] = [
  'memory_view',
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
]

/** Name of one memory tool. */
export type MemoryToolName = (typeof MEMORY_TOOLS)[number]

/**
 * Executes one memory command for the current session and turn (roots, file system, limits and
 * `onWrite` bound). Passed to the `tool` option; its signature fits a provider tool's `execute`.
 */
export type MemoryExecutor = (
  input: MemoryCommand,
  options?: { toolCallId?: string },
) => Promise<string>

const path = z.string().describe('Absolute path inside a memory root, e.g. /memories/notes.md')

/** Create the six memory tools over `execute`. */
export function createMemoryTools(execute: MemoryExecutor): Record<MemoryToolName, Tool> {
  return {
    memory_view: tool({
      description:
        'Show a memory file with line numbers, or list the files of a memory directory (with sizes). view_range [start, end] is 1-based and inclusive; end -1 means the end of the file.',
      inputSchema: z.object({
        path,
        view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
      }),
      execute: (input, { toolCallId }) => execute({ command: 'view', ...input }, { toolCallId }),
    }),
    memory_create: tool({
      description:
        'Create a new memory file with the given text. Fails if the file already exists (edit it instead).',
      inputSchema: z.object({ path, file_text: z.string() }),
      execute: (input, { toolCallId }) => execute({ command: 'create', ...input }, { toolCallId }),
    }),
    memory_str_replace: tool({
      description:
        'Replace the exact text old_str (which must occur exactly once) with new_str in a memory file.',
      inputSchema: z.object({ path, old_str: z.string(), new_str: z.string() }),
      execute: (input, { toolCallId }) =>
        execute({ command: 'str_replace', ...input }, { toolCallId }),
    }),
    memory_insert: tool({
      description:
        'Insert insert_text after line insert_line of a memory file (0 inserts at the start).',
      inputSchema: z.object({
        path,
        insert_line: z.number().int().min(0),
        insert_text: z.string(),
      }),
      execute: (input, { toolCallId }) => execute({ command: 'insert', ...input }, { toolCallId }),
    }),
    memory_delete: tool({
      description: 'Delete a memory file.',
      inputSchema: z.object({ path }),
      execute: (input, { toolCallId }) => execute({ command: 'delete', ...input }, { toolCallId }),
    }),
    memory_rename: tool({
      description: 'Rename or move a memory file. Fails if new_path already exists.',
      inputSchema: z.object({ old_path: path, new_path: path }),
      execute: (input, { toolCallId }) => execute({ command: 'rename', ...input }, { toolCallId }),
    }),
  }
}
