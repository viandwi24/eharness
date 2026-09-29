/**
 * `eharness/filesystem`: the `FileSystem` contract, the `filesystem()` plugin with the file
 * tools, the filesystem skill source and helpers.
 *
 * The reference plugin: built only with the public core API (`src/index.ts`, ADR-0008).
 *
 * @see docs/specs/08-filesystem-plugin.md
 */
import type { FileSystem, ToolOutputStore } from './types.ts'

export { normalizePath } from './paths.ts'
export type {
  DeleteResult,
  FileChangeData,
  FileEntry,
  FileMeta,
  FileSystem,
  FilesystemOptions,
  FileToolName,
  GrepHit,
  ToolOutputStore,
  WriteResult,
} from './types.ts'
export { contentVersion } from './version.ts'

declare module '../index.ts' {
  interface HarnessServices {
    /** The file system of the session, provided by the `filesystem()` plugin (spec 08). */
    fs: FileSystem
    /** Store for evicted tool outputs, provided by the `filesystem()` plugin (spec 08 §2). */
    toolOutputs: ToolOutputStore
  }
}
