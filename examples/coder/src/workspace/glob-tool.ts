/** The `glob` tool: find files by pattern, newest first (docs/plans/P30-coder-example.md §6.1). */
import { realpath, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { tool } from 'ai'
import { glob } from 'tinyglobby'
import { z } from 'zod/v4'
import type { Workspace } from '../contracts.ts'
import { isInside, loadIgnoreRules } from './guard.ts'

const MAX_RESULTS = 200

/**
 * Why a pattern may not be used, or `null`. Rejects backslashes (tinyglobby treats `\/` as `/`),
 * `..` segments, absolute patterns and a leading `~`.
 */
function patternProblem(pattern: string): string | null {
  if (pattern.includes('\\')) return 'the pattern may not contain backslashes; use "/"'
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:/.test(pattern)) {
    return 'the pattern must be relative to `path` (no leading "/" or "~")'
  }
  if (pattern.split('/').includes('..')) return 'the pattern may not contain ".."'
  return null
}

/**
 * Build the `glob` tool over a workspace. Results are virtual paths, newest first, at most 200;
 * `.git/`, `node_modules/` and `.gitignore` entries are excluded. Failures return `ERROR:` strings.
 *
 * @param workspace The workspace whose mounts are searched.
 */
export function createGlobTool(workspace: Workspace): ReturnType<typeof makeGlobTool> {
  return makeGlobTool(workspace)
}

function makeGlobTool(workspace: Workspace) {
  return tool({
    description:
      'Find files by glob pattern (e.g. "src/**/*.ts"), newest first, at most 200. `path` is the virtual directory to search (default "/"). Ignored paths (.git, node_modules, .gitignore) are skipped.',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('Glob pattern, relative to `path`.'),
      path: z.string().optional().describe('Virtual directory to search; default "/".'),
    }),
    metadata: { risk: 'read' },
    execute: async ({ pattern, path }): Promise<string> => {
      try {
        const bad = patternProblem(pattern)
        if (bad) return `ERROR: ${bad}`
        const dir = (path ?? '/').replace(/(.)\/+$/, '$1')
        const realDir = await workspace.toReal(dir)
        if (realDir === null) return `ERROR: path outside the workspace: ${dir}`
        const base = workspace.toVirtual(realDir)
        if (base === null) return `ERROR: path outside the workspace: ${dir}`
        const mount = workspace
          .mounts()
          .filter((m) => realDir === m.real || realDir.startsWith(m.real + sep))
          .sort((a, b) => b.real.length - a.real.length)[0]
        if (!mount) return `ERROR: path outside the workspace: ${dir}`
        const rules = await loadIgnoreRules(mount.real)
        const realMount = await realpath(mount.real)

        const matches = await glob(pattern, {
          cwd: realDir,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false, // symlinked dirs are not followed; results are also re-checked below
          ignore: ['**/.git/**', '**/node_modules/**'],
        })
        const visible: Array<{ virtual: string; mtime: number }> = []
        for (const match of matches) {
          const rel = relative(mount.real, `${realDir}/${match}`).split(sep).join('/')
          if (rules.isHidden(rel, false)) continue
          const virtual = base.endsWith('/') ? base + match : `${base}/${match}`
          // Defence in depth: a result must really live inside the mount (symlinks, odd patterns).
          const real = await realpath(`${realDir}/${match}`).catch(() => null)
          if (real === null || !isInside(realMount, real)) continue
          const info = await stat(real).catch(() => null)
          if (info) visible.push({ virtual, mtime: info.mtimeMs })
        }
        if (visible.length === 0) return 'No files match.'
        visible.sort((a, b) => b.mtime - a.mtime || (a.virtual < b.virtual ? -1 : 1))
        const lines = visible.slice(0, MAX_RESULTS).map((v) => v.virtual)
        if (visible.length > MAX_RESULTS) {
          lines.push(`(Showing ${MAX_RESULTS} of ${visible.length} matches; narrow the pattern.)`)
        }
        return lines.join('\n')
      } catch (error) {
        return `ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
