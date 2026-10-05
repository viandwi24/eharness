/**
 * Model-visible texts of the memory plugin (spec 14 §4–§5). Changing any of them is a minor
 * change (`docs/engineering/api-stability.md`).
 *
 * @see docs/specs/14-memory-plugin.md
 */

/**
 * Default memory protocol: a static instruction (instructions block 1, identical for every user and
 * turn). The structure (when to look, when to write, keep files small) is public; the wording is
 * not.
 */
export const MEMORY_PROTOCOL: string = `You have a persistent memory: files that survive across conversations, kept under the memory roots listed in the reminder of each turn. Use the memory tools to view, create and edit them.
- Before starting a task, view the relevant memory files for earlier progress, decisions and preferences.
- While you work, record progress, decisions and facts worth keeping. Assume your context may be reset at any time: anything not written to memory can be lost.
- Keep memory files small, focused and organized: update or remove outdated entries instead of appending duplicates, and use descriptive file names.
- Read-only roots hold shared knowledge you can consult but not change. Never store secrets or credentials in memory.`

/** `REJECTED:` for a path outside every root. */
export const outsideText = (path: string): string =>
  `REJECTED: ${path} is outside the memory roots.`

/** `REJECTED:` for a write to a read-only root. */
export const readOnlyText = (path: string): string => `REJECTED: ${path} is read-only.`

/** `ERROR:` for a missing file. */
export const missingText = (path: string): string => `ERROR: ${path} does not exist.`

/** `ERROR:` for content over `maxFileChars`. */
export const tooLargeText = (path: string, max: number): string =>
  `ERROR: ${path} would exceed ${max} characters.`

/** `CONFLICT:` after a failed compare-and-set. */
export const conflictText = (path: string): string =>
  `CONFLICT: ${path} was changed meanwhile; nothing was written. Run the command again.`
