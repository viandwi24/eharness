/**
 * `eharness/filesystem/node`: a `FileSystem` over real directories, mounts, a workspace helper
 * and a durable checkpoint store. Node-only (ADR-0036): it imports `node:` built-ins.
 *
 * @see docs/specs/08-filesystem-plugin.md#8-node-adapter
 */
export { type NodeCheckpointStoreOptions, nodeCheckpointStore } from './node/checkpoint-store.ts'
export {
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  type DiskFsOptions,
  diskFs,
} from './node/disk-fs.ts'
export { compileIgnore, type IgnoreRules } from './node/ignore.ts'
export { type FsMount, mountFs } from './node/mount-fs.ts'
export {
  type NodeWorkspace,
  type NodeWorkspaceOptions,
  nodeWorkspace,
  type WorkspaceMount,
} from './node/workspace.ts'
