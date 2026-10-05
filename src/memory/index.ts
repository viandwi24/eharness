/**
 * `eharness/memory`: the `memory()` plugin — file-based long-term memory on the `fs` service with
 * application-chosen roots, pinned files in the turn reminder and an executor for app-supplied
 * (e.g. provider-defined) memory tools.
 *
 * @see docs/specs/14-memory-plugin.md
 */
export {
  DEFAULT_MAX_FILE_CHARS,
  executeMemoryCommand,
  type MemoryCommand,
  type MemoryExecuteOptions,
  type MemoryFileSystem,
  type MemoryRoot,
  type MemoryWriteEvent,
} from './execute.ts'
export { DEFAULT_MAX_PINNED_CHARS, type MemoryOptions, memory } from './plugin.ts'
export { MEMORY_PROTOCOL } from './texts.ts'
export { MEMORY_TOOLS, type MemoryExecutor, type MemoryToolName } from './tools.ts'
