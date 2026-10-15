/**
 * `eharness/filesystem`: the `FileSystem` contract, the `filesystem()` plugin with the file
 * tools, the filesystem skill source and helpers.
 *
 * The reference plugin: built only with the public core API (`src/index.ts`, ADR-0008).
 *
 * @see docs/specs/08-filesystem-plugin.md
 */
import type { ProjectInstructionsInfo } from './project-instructions.ts'
import type { FilePolicy, FileSystem, ToolMediaStore, ToolOutputStore } from './types.ts'

export {
  type CheckpointKey,
  type CheckpointRecord,
  type CheckpointStore,
  checkpointedFs,
  checkpointsSince,
  DEFAULT_CHECKPOINT_KEEP_TURNS,
  type FileCheckpoint,
  type FileSnapshot,
  type InMemoryCheckpointStoreOptions,
  inMemoryCheckpointStore,
  type RewindFilesResult,
  rewindFiles,
} from './checkpoints.ts'
export { classifyToolResult, type FileToolResultKind } from './classify.ts'
export { type CompiledGlob, compileGlob } from './glob.ts'
export { detectMediaType, looksBinary } from './media.ts'
export { normalizePath } from './paths.ts'
export {
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_TOOL_OUTPUTS_DIR,
  type FilesystemDataParts,
  filesystem,
} from './plugin.ts'
export {
  DEFAULT_PROJECT_INSTRUCTION_FILES,
  DEFAULT_PROJECT_INSTRUCTIONS_MAX_CHARS,
  DEFAULT_PROJECT_INSTRUCTIONS_MAX_NESTED,
  loadProjectInstructions,
  type NestedProjectInstructionFile,
  type ProjectInstructionFile,
  type ProjectInstructionsInfo,
  type ProjectInstructionsOptions,
  projectInstructions,
} from './project-instructions.ts'
export { type FsSkillSourceOptions, fsSkillSource } from './skill-source.ts'
export { GREP_SCAN_CHARS, splitLines, statelessPattern } from './text.ts'
export { type FileMediaRef, isFileMediaRef } from './tools.ts'
export type {
  BinaryFile,
  DeleteResult,
  FileChangeData,
  FileEntry,
  FileMeta,
  FilePolicy,
  FileSystem,
  FilesystemOptions,
  FileToolName,
  FileVersion,
  GrepHit,
  MoveResult,
  ToolMediaStore,
  ToolOutputStore,
  WriteResult,
} from './types.ts'
export { bytesVersion, contentVersion } from './version.ts'

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
    /**
     * Store for the media of MCP-style tool results, provided by the `filesystem()` plugin (spec
     * 08 §2). Absent with `filesystem({ toolMedia: false })`.
     */
    toolMedia: ToolMediaStore
    /**
     * The hidden / read-only / extension / undeletable rules of the file tools, provided by the
     * `filesystem()` plugin (spec 08 §2); plugins that move files outside the tools use it.
     */
    filePolicy: FilePolicy
    /**
     * What `projectInstructions()` loaded at session open (spec 08 §13): the chosen root file,
     * the nested files and the candidates that lost the preference.
     */
    projectInstructions: ProjectInstructionsInfo
  }
}
