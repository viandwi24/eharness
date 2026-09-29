/**
 * `eharness/filesystem`: the `FileSystem` contract, the `filesystem()` plugin with the file
 * tools, the filesystem skill source and helpers.
 *
 * The reference plugin: built only with the public core API (`src/index.ts`, ADR-0008).
 *
 * @see docs/specs/08-filesystem-plugin.md
 */
import type { FileSystem, ToolOutputStore } from './types.ts'

export { classifyToolResult, type FileToolResultKind } from './classify.ts'
export { normalizePath } from './paths.ts'
export {
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_TOOL_OUTPUTS_DIR,
  type FilesystemDataParts,
  filesystem,
} from './plugin.ts'
export { type FsSkillSourceOptions, fsSkillSource } from './skill-source.ts'
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

declare module 'eharness' {
  interface HarnessServices {
    /** The file system of the session, provided by the `filesystem()` plugin (spec 08). */
    fs: FileSystem
    /**
     * Store for evicted tool outputs, provided by the `filesystem()` plugin (spec 08 §2).
     * Absent with `filesystem({ toolOutputs: false })`: accessing it then throws
     * `EH_SERVICE_MISSING` (declare `requires: ['toolOutputs']` to get a boot error instead).
     */
    toolOutputs: ToolOutputStore
  }
}
