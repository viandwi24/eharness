/**
 * Filesystem skill source (spec 07 §8): skills stored as `<root>/<name>/SKILL.md` plus
 * supporting files, served through the `SkillSource` contract.
 *
 * @see docs/specs/07-skills.md#8-filesystem-autoload-in-eharnessfilesystem
 */
import {
  defineSkillSource,
  type HarnessContext,
  HarnessError,
  parseSkillMarkdown,
  type SkillDoc,
  type SkillMeta,
  type SkillSource,
  validateSkillPath,
} from '../index.ts'
import { dirPrefix, joinPath, normalizePath } from './paths.ts'
import type { FileEntry, FileSystem } from './types.ts'

/** Options of {@link fsSkillSource}. */
export interface FsSkillSourceOptions {
  /** Directory holding one sub-directory per skill (`<root>/<name>/SKILL.md`). */
  root: string
  /** When the core calls `list()`. Default `'session'`. */
  refresh?: 'session' | 'turn'
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const isSkillName = (name: string): boolean =>
  typeof name === 'string' && name.length <= 64 && SKILL_NAME.test(name)

type Parsed = ReturnType<typeof parseSkillMarkdown>

/**
 * A {@link SkillSource} over a {@link FileSystem}: every `<root>/<name>/SKILL.md` (one level
 * deep) is a skill; the other files under `<root>/<name>/` are its supporting files.
 *
 * - `list`: parses each `SKILL.md` with `parseSkillMarkdown` (cached by file version, so
 *   `refresh: 'turn'` is cheap). An unparsable file, or a `name` that differs from the
 *   directory, is skipped with `W_INVALID_SKILL` (once per file version).
 * - `load`: body + manifest (paths relative to the skill, UTF-8 sizes, never `SKILL.md`).
 * - `readFile`: re-validates the skill-relative path, then reads `<root>/<name>/<path>`.
 * - `locate`: `{ service: 'fs', root: '<root>/<name>' }` for executor plugins (spec 07 §7).
 *
 * The `filesystem()` plugin adds this source for its `skills` option; use it directly to serve
 * skills from any `FileSystem` (e.g. a shared read-only skills store).
 *
 * @example
 * ```ts
 * defineHarnessAgent({ model, skills: [fsSkillSource(memoryFs(seed), { root: '/skills' })] })
 * ```
 * @throws {HarnessError} `EH_CONFIG_INVALID` for an invalid `root` or `refresh`.
 * @see docs/specs/07-skills.md#8-filesystem-autoload-in-eharnessfilesystem
 */
export function fsSkillSource(fs: FileSystem, opts: FsSkillSourceOptions): SkillSource {
  const normalized = normalizePath(opts?.root)
  if (!normalized.ok) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `fsSkillSource: invalid root ${JSON.stringify(opts?.root)}: ${normalized.error}.`,
    )
  }
  const refresh = opts.refresh ?? 'session'
  if (refresh !== 'session' && refresh !== 'turn') {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `fsSkillSource: refresh must be 'session' or 'turn', got ${JSON.stringify(opts.refresh)}.`,
    )
  }
  const root = normalized.path
  const id = `fs:${root}`
  const cache = new Map<string, { version: string; parsed: Parsed }>()
  const warned = new Set<string>()

  const skillDir = (name: string): string => joinPath(root, name)

  const parse = (entry: FileEntry): Parsed => {
    const hit = cache.get(entry.path)
    if (hit !== undefined && hit.version === entry.version) return hit.parsed
    const parsed = parseSkillMarkdown(entry.content)
    cache.set(entry.path, { version: entry.version, parsed })
    return parsed
  }

  const skip = (ctx: HarnessContext, path: string, version: string, why: string): void => {
    const key = `${path}@${version}`
    if (warned.has(key)) return
    warned.add(key)
    ctx.warn({
      code: 'W_INVALID_SKILL',
      message: `Skipped skill file ${path}: ${why}`,
      details: { source: id, path },
    })
  }

  return defineSkillSource({
    id,
    refresh,

    async list(ctx): Promise<SkillMeta[]> {
      const prefix = dirPrefix(root)
      const out: SkillMeta[] = []
      const files = await fs.list(prefix)
      // forget deleted skill files so the caches stay bounded by the current listing
      const current = new Set(files.map((file) => `${file.path}@${file.version}`))
      const paths = new Set(files.map((file) => file.path))
      for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path)
      for (const key of warned) if (!current.has(key)) warned.delete(key)
      for (const file of files) {
        const segments = file.path.slice(prefix.length).split('/')
        if (segments.length !== 2 || segments[1] !== 'SKILL.md') continue
        const name = segments[0] as string
        const hit = cache.get(file.path)
        let parsed: Parsed
        if (hit !== undefined && hit.version === file.version) {
          parsed = hit.parsed
        } else {
          const entry = await fs.read(file.path)
          if (entry === null) continue
          parsed = parse(entry)
        }
        const version = cache.get(file.path)?.version ?? file.version
        if ('error' in parsed) {
          skip(ctx, file.path, version, parsed.error)
          continue
        }
        if (parsed.meta.name !== name) {
          skip(
            ctx,
            file.path,
            version,
            `name "${parsed.meta.name}" does not match its directory "${name}"`,
          )
          continue
        }
        out.push(structuredClone(parsed.meta))
      }
      return out
    },

    async load(name): Promise<SkillDoc | null> {
      if (!isSkillName(name)) return null
      const dir = skillDir(name)
      const entry = await fs.read(joinPath(dir, 'SKILL.md'))
      if (entry === null) return null
      const parsed = parse(entry)
      if ('error' in parsed) throw new Error(`invalid SKILL.md: ${parsed.error}`)
      if (parsed.meta.name !== name) return null
      const prefix = dirPrefix(dir)
      const manifest: SkillDoc['manifest'] = []
      for (const file of await fs.list(prefix)) {
        const relative = file.path.slice(prefix.length)
        const valid = validateSkillPath(relative)
        if (!valid.ok || valid.path !== relative) continue
        manifest.push({ path: relative, size: file.size })
      }
      return { ...structuredClone(parsed.meta), content: parsed.body, manifest }
    },

    async readFile(name, path) {
      if (!isSkillName(name)) return null
      // defence in depth: the core validates before calling
      const valid = validateSkillPath(path)
      if (!valid.ok) return null
      const entry = await fs.read(joinPath(skillDir(name), valid.path))
      return entry === null ? null : { type: 'text', text: entry.content }
    },

    locate(name) {
      return isSkillName(name) ? { service: 'fs', root: skillDir(name) } : null
    },
  })
}
