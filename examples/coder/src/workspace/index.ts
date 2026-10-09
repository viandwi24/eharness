/**
 * The workspace of the coder example: `nodeWorkspace()` from the library (a virtual tree: `/` =
 * project root, `/@dirs/<name>/` = extra directories, `/.eharness/tool-outputs/` = evicted tool
 * outputs) over the project's real directories.
 */
import { join } from 'node:path'
import { DEFAULT_TOOL_OUTPUTS_DIR } from 'eharness/filesystem'
import { nodeWorkspace } from 'eharness/filesystem/node'
import type { CoderConfig, Workspace } from '../contracts.ts'

export { createDirAccessTool } from './dir-access.ts'

/** The mount of evicted tool outputs: readable and writable, but not a working directory. */
export const TOOL_OUTPUTS_VIRTUAL = `${DEFAULT_TOOL_OUTPUTS_DIR}/`

/**
 * Build the workspace from the configuration. Creates `<projectDataDir>/tool-outputs`.
 *
 * @param config Resolved coder configuration (all paths real and absolute).
 */
export function createWorkspace(config: CoderConfig): Promise<Workspace> {
  return nodeWorkspace({
    root: config.root,
    extraDirs: config.additionalDirectories,
    toolOutputsDir: join(config.projectDataDir, 'tool-outputs'),
  })
}
