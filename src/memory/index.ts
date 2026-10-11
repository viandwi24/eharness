/**
 * `eharness/memory`: the `memory()` plugin — file-based long-term memory on the `fs` service with
 * application-chosen roots, pinned files in the turn reminder and an executor for app-supplied
 * (e.g. provider-defined) memory tools.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/14-memory-plugin.md
 */
export {
  executeMemoryCommand,
  type MemoryCommand,
  type MemoryExecuteOptions,
  type MemoryFileSystem,
  type MemoryRoot,
  type MemoryWriteEvent,
} from './execute.ts'
export {
  MEMORY_FLUSH_TOOLS,
  type MemoryOptions,
  memory,
} from './plugin.ts'
export { MEMORY_TOOLS, type MemoryExecutor, type MemoryToolName } from './tools.ts'
