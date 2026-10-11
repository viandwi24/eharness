/**
 * Path handling of the memory plugin (spec 14 §3).
 *
 * `eharness/memory` imports core only through `src/index.ts` and never another subpath
 * (ADR-0008); the path rules of `normalizePath` from `eharness/filesystem` (spec 08 §1) live in
 * core (`normalizeRootedPath`) and both modules delegate to it.
 *
 * @see docs/specs/14-memory-plugin.md#3-paths-and-roots
 */

import { normalizeRootedPath } from '../index.ts'

/** The path rules of `normalizePath` from `eharness/filesystem` (spec 08 §1), shared through core. */
export function normalizeMemoryPath(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  return normalizeRootedPath(path)
}

/** True when `path` is `dir` itself or inside the directory `dir` (both normalized). */
export function isUnder(path: string, dir: string): boolean {
  if (dir === '/') return true
  return path === dir || path.startsWith(`${dir}/`)
}

/** Directory form of a normalized path (`'/a'` → `'/a/'`, `'/'` stays `'/'`). */
export function dirPrefix(path: string): string {
  return path === '/' ? '/' : `${path}/`
}
