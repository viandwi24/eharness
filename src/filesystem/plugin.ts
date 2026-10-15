/**
 * The `filesystem()` plugin (spec 08 §2): the `fs` and `toolOutputs` services, the file tools,
 * the `data-filesystem.change` part and skills autoload.
 *
 * @see docs/specs/08-filesystem-plugin.md#2-plugin
 */
import type { FlexibleSchema } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartDef,
  definePlugin,
  type HarnessContext,
  HarnessError,
  type HarnessPlugin,
  type SessionContribution,
} from '../index.ts'
import { checkpointedFs, checkpointTurnKey, copyCheckpoints } from './checkpoints.ts'
import { lastReadOf } from './last-read.ts'
import { isUnderAnyFolded, joinPath, normalizePath, normalizePrefixes } from './paths.ts'
import { fsSkillSource } from './skill-source.ts'
import { createFileTools, DEFAULT_MEDIA_MAX_BYTES } from './tools.ts'
import type {
  FileChangeData,
  FilePolicy,
  FileSystem,
  FilesystemOptions,
  FileToolName,
  ToolMediaStore,
  ToolOutputStore,
} from './types.ts'
import { contentVersion } from './version.ts'

/** Default directory of the `toolOutputs` service. */
export const DEFAULT_TOOL_OUTPUTS_DIR = '/.eharness/tool-outputs'

/** Default directory of the `toolMedia` service. */
export const DEFAULT_TOOL_MEDIA_DIR = '/.eharness/tool-media'

/** Default `toolMedia.keep`. */
export const DEFAULT_TOOL_MEDIA_KEEP = 20

/** Default `maxReadChars`. */
export const DEFAULT_MAX_READ_CHARS = 50_000

const FILE_TOOLS: readonly FileToolName[] = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'grep',
  'glob',
]

/** Data parts of the filesystem plugin (`data-filesystem.change`). */
export type FilesystemDataParts = {
  /** `data-filesystem.change` (spec 08 §5). */
  change: DataPartDef<FlexibleSchema<FileChangeData>>
}

const changePart: DataPartDef<FlexibleSchema<FileChangeData>> = {
  schema: z.object({
    path: z.string(),
    action: z.enum(['create', 'write', 'edit', 'delete']),
    version: z.string().nullable(),
    bytes: z.number().int().nonnegative().optional(),
  }),
  model: 'omit',
}

function invalid(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', `filesystem: ${message}`, {
    details: { plugin: 'filesystem' },
  })
}

function isFileSystem(value: unknown): value is FileSystem {
  if (typeof value !== 'object' || value === null) return false
  const fs = value as Record<string, unknown>
  return ['read', 'write', 'delete', 'list'].every((key) => typeof fs[key] === 'function')
}

function prefixes(list: unknown, what: string): string[] {
  if (list === undefined) return []
  if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) {
    invalid(`\`${what}\` must be an array of paths.`)
  }
  try {
    return normalizePrefixes(list, `\`${what}\``)
  } catch (error) {
    return invalid((error as Error).message)
  }
}

function directory(path: unknown, what: string): string {
  const result = normalizePath(path as string)
  if (!result.ok) invalid(`invalid \`${what}\` ${JSON.stringify(path)}: ${result.error}.`)
  return result.path
}

/** The `toolOutputs` service over `fs`: `<dir>/<toolCallId>.txt`, written unconditionally. */
function toolOutputStore(fs: FileSystem, dir: string): ToolOutputStore {
  return {
    async put(toolCallId, text) {
      const id = String(toolCallId)
      let name = id.replace(/[^A-Za-z0-9_-]/g, '_')
      // sanitizing may merge distinct ids (a.b / a_b): disambiguate with a short content hash
      if (name !== id || name === '')
        name = `${name || 'output'}-${(await contentVersion(id)).slice(0, 8)}`
      const path = joinPath(dir, `${name}.txt`)
      const result = await fs.write(path, text)
      if (!result.ok)
        throw new HarnessError(
          'EH_STORAGE',
          `toolOutputs: could not write ${path} (${result.reason})`,
        )
      return path
    },
  }
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
}

/**
 * The `toolMedia` service over `fs`: `<dir>/<session>-<toolCallId>-<index>.<ext>`, the newest
 * `keep` files of a session stay (best-effort deletes). The order is the order of `put` in this
 * process; the first `put` of a session seeds it from the directory (by `updatedAt`).
 */
function toolMediaStore(
  fs: FileSystem,
  dir: string,
  keep: number,
  sessionId: string,
): ToolMediaStore {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_')
  const prefix = `${clean(sessionId).slice(0, 40)}-`
  let order: string[] | undefined
  const seed = async (): Promise<string[]> => {
    if (order !== undefined) return order
    order = []
    try {
      const listed = (await fs.list(`${dir}/`)).filter((f) =>
        f.path.slice(f.path.lastIndexOf('/') + 1).startsWith(prefix),
      )
      listed.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || (a.path < b.path ? -1 : 1))
      order = listed.map((f) => f.path)
    } catch {
      // the retention starts from this process
    }
    return order
  }
  return {
    async put(_sessionId, toolCallId, index, bytes, mediaType) {
      if (typeof fs.writeBytes !== 'function' || typeof fs.readBytes !== 'function') return null
      const ext = MEDIA_EXTENSIONS[mediaType.toLowerCase()] ?? 'bin'
      const path = joinPath(dir, `${prefix}${clean(String(toolCallId))}-${index}.${ext}`)
      const files = await seed()
      const written = await fs.writeBytes(path, bytes, { mediaType, author: 'tool-media' })
      if (!written.ok) {
        throw new HarnessError(
          'EH_STORAGE',
          `toolMedia: could not write ${path} (${written.reason})`,
        )
      }
      const at = files.indexOf(path)
      if (at !== -1) files.splice(at, 1)
      files.push(path)
      while (files.length > keep) {
        const old = files.shift() as string
        void Promise.resolve(fs.delete(old)).catch(() => undefined)
      }
      return { path, version: written.version, bytes: bytes.length }
    },
    async read(path) {
      try {
        const file = await fs.readBytes?.(path)
        return file === null || file === undefined
          ? null
          : { bytes: file.bytes, version: file.meta.version }
      } catch {
        return null
      }
    },
  }
}

/** The `filePolicy` service over the normalized options the file tools use (spec 08 §2). */
function createFilePolicy(env: {
  hidden: readonly string[]
  readonly: readonly string[]
  allowedExtensions: readonly string[] | undefined
  isUndeletable: ((path: string) => boolean) | undefined
}): FilePolicy {
  return {
    isHidden: (path) => isUnderAnyFolded(path, env.hidden),
    isReadonly: (path) => isUnderAnyFolded(path, env.readonly),
    extensionAllowed(path) {
      if (env.allowedExtensions === undefined) return true
      const base = path.slice(path.lastIndexOf('/') + 1)
      const dot = base.lastIndexOf('.')
      return env.allowedExtensions.includes(dot > 0 ? base.slice(dot).toLowerCase() : '')
    },
    isUndeletable: (path) => env.isUndeletable?.(path) === true,
  }
}

/**
 * The filesystem plugin: provides the `fs` service (a {@link FileSystem}), the `toolOutputs`
 * service and the `filePolicy` service, the file tools `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`,
 * `grep` and `glob` with the editing rules of spec 08 §4 (read before edit/overwrite/delete, `STALE:`
 * with the current content, smart replace, optimistic locking), the `data-filesystem.change`
 * part on every mutation, and skills autoload from the same file system.
 *
 * `fs` is an adapter, or a resolver called once per session at session open (one file system per
 * session/project). `lastRead` lives in `ctx.state`, so staleness survives restarts with a
 * persistent `StateAdapter`.
 *
 * @example
 * ```ts
 * const agent = defineHarnessAgent({
 *   model,
 *   plugins: [
 *     filesystem({
 *       fs: inMemoryFs({ seed: { '/README.md': '# Hello\n' } }),
 *       skills: { root: '/skills', refresh: 'turn' },
 *       readonlyPrefixes: ['/vendor'],
 *     }),
 *   ],
 * })
 * ```
 * @throws {HarnessError} `EH_CONFIG_INVALID` for invalid options (at definition time) or when the
 *   resolver returns something that is not a `FileSystem` (at session open).
 * @see docs/specs/08-filesystem-plugin.md#2-plugin
 */
export function filesystem(
  opts: FilesystemOptions,
): HarnessPlugin<'filesystem', FilesystemDataParts> {
  if (typeof opts !== 'object' || opts === null) invalid('expected an options object.')
  if (typeof opts.fs !== 'function' && !isFileSystem(opts.fs)) {
    invalid('`fs` must be a FileSystem (read, write, delete, list) or a function returning one.')
  }
  const maxReadChars = opts.maxReadChars ?? DEFAULT_MAX_READ_CHARS
  if (!Number.isInteger(maxReadChars) || maxReadChars < 100) {
    invalid('`maxReadChars` must be an integer ≥ 100.')
  }
  const tools = opts.tools ?? FILE_TOOLS
  if (!Array.isArray(tools) || tools.some((name) => !FILE_TOOLS.includes(name))) {
    invalid(`\`tools\` must be a list of ${FILE_TOOLS.join(', ')}.`)
  }
  if (opts.isUndeletable !== undefined && typeof opts.isUndeletable !== 'function') {
    invalid('`isUndeletable` must be a function.')
  }
  let allowedExtensions: string[] | undefined
  if (opts.allowedExtensions !== undefined) {
    if (!Array.isArray(opts.allowedExtensions)) invalid('`allowedExtensions` must be an array.')
    allowedExtensions = opts.allowedExtensions.map((ext) => {
      if (typeof ext !== 'string' || !/^\.?[^./]+$/.test(ext)) {
        invalid(`invalid extension ${JSON.stringify(ext)} in \`allowedExtensions\`.`)
      }
      return (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()
    })
  }
  if (
    opts.checkpoints !== undefined &&
    ['save', 'load', 'list', 'delete'].some(
      (key) =>
        typeof (opts.checkpoints as unknown as Record<string, unknown>)?.[key] !== 'function',
    )
  ) {
    invalid('`checkpoints` must be a CheckpointStore (save, load, list, delete).')
  }
  if (opts.onAdapterError !== undefined && typeof opts.onAdapterError !== 'function') {
    invalid('`onAdapterError` must be a function.')
  }
  if (opts.media !== undefined && (typeof opts.media !== 'object' || opts.media === null)) {
    invalid('`media` must be { images?, pdf?, maxBytes? }.')
  }
  const media = {
    images: opts.media?.images ?? true,
    pdf: opts.media?.pdf ?? false,
    maxBytes: opts.media?.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
  }
  if (!Number.isInteger(media.maxBytes) || media.maxBytes < 1) {
    invalid('`media.maxBytes` must be a positive integer.')
  }
  const hidden = prefixes(opts.hiddenPrefixes, 'hiddenPrefixes')
  const readonly = prefixes(opts.readonlyPrefixes, 'readonlyPrefixes')

  let skills: { root: string; refresh: 'session' | 'turn' } | undefined
  if (opts.skills !== undefined) {
    const root = directory(opts.skills?.root, 'skills.root')
    const refresh = opts.skills.refresh ?? 'session'
    if (refresh !== 'session' && refresh !== 'turn') {
      invalid("`skills.refresh` must be 'session' or 'turn'.")
    }
    skills = { root, refresh }
    if (opts.skills.hideSkillsRoot !== false && !hidden.includes(root)) hidden.push(root)
  }

  let outputsDir: string | undefined
  if (opts.toolOutputs !== false) {
    if (
      opts.toolOutputs !== undefined &&
      (typeof opts.toolOutputs !== 'object' || opts.toolOutputs === null)
    ) {
      invalid('`toolOutputs` must be false or { dir?: string }.')
    }
    outputsDir = directory(opts.toolOutputs?.dir ?? DEFAULT_TOOL_OUTPUTS_DIR, 'toolOutputs.dir')
    if (outputsDir === '/') invalid('`toolOutputs.dir` must not be the root.')
    if (!readonly.includes(outputsDir)) readonly.push(outputsDir)
  }

  let mediaDir: string | undefined
  let mediaKeep = DEFAULT_TOOL_MEDIA_KEEP
  if (opts.toolMedia !== false) {
    if (
      opts.toolMedia !== undefined &&
      (typeof opts.toolMedia !== 'object' || opts.toolMedia === null)
    ) {
      invalid('`toolMedia` must be false or { dir?: string; keep?: number }.')
    }
    mediaDir = directory(opts.toolMedia?.dir ?? DEFAULT_TOOL_MEDIA_DIR, 'toolMedia.dir')
    if (mediaDir === '/') invalid('`toolMedia.dir` must not be the root.')
    const keep = opts.toolMedia?.keep
    if (keep !== undefined) {
      if (!Number.isInteger(keep) || keep < 1) invalid('`toolMedia.keep` must be an integer >= 1.')
      mediaKeep = keep
    }
    if (!readonly.includes(mediaDir)) readonly.push(mediaDir)
  }

  return definePlugin({
    name: 'filesystem',
    provides: [
      'fs',
      ...(outputsDir === undefined ? [] : ['toolOutputs']),
      ...(mediaDir === undefined ? [] : ['toolMedia']),
      'filePolicy',
    ],
    dataParts: { change: changePart },
    setup() {
      const store = opts.checkpoints
      if (store === undefined) return
      return {
        hooks: {
          // a fork keeps the file checkpoints of the turns it kept (spec 08 §11)
          async 'session.fork'(_ctx, e) {
            await copyCheckpoints({
              store,
              from: e.sourceSessionId,
              to: e.targetSessionId,
              ...(e.beforeMessageId === undefined ? {} : { beforeTurnKey: e.beforeMessageId }),
            })
          },
        },
      }
    },
    async session(ctx): Promise<SessionContribution<FilesystemDataParts>> {
      const fs =
        typeof opts.fs === 'function' ? await opts.fs(ctx as unknown as HarnessContext) : opts.fs
      if (!isFileSystem(fs)) {
        invalid('the `fs` resolver must return a FileSystem (read, write, delete, list).')
      }
      const visible =
        opts.checkpoints === undefined
          ? fs
          : checkpointedFs({
              fs,
              store: opts.checkpoints,
              sessionId: ctx.session.id,
              turnKey: () => (ctx.turn === undefined ? undefined : checkpointTurnKey(ctx.turn)),
              skip: (path) =>
                [outputsDir, mediaDir].some(
                  (dir) => dir !== undefined && (path === dir || path.startsWith(`${dir}/`)),
                ),
              onError: (path, error) =>
                ctx.log.warn(`checkpoint of ${path} failed: ${String(error)}`),
            })
      const filePolicy = createFilePolicy({
        hidden,
        readonly,
        allowedExtensions,
        isUndeletable: opts.isUndeletable,
      })
      const contribution: SessionContribution<FilesystemDataParts> = {
        services: {
          fs: visible,
          ...(outputsDir === undefined ? {} : { toolOutputs: toolOutputStore(fs, outputsDir) }),
          ...(mediaDir === undefined
            ? {}
            : { toolMedia: toolMediaStore(fs, mediaDir, mediaKeep, ctx.session.id) }),
          filePolicy,
        },
        tools: createFileTools(
          {
            fs: visible,
            lastRead: lastReadOf(ctx.state),
            change: (data) => ctx.stream.data('change', data, { id: data.path }),
            hidden,
            readonly,
            unlisted: [outputsDir, mediaDir].filter((d): d is string => d !== undefined),
            allowedExtensions,
            isUndeletable: opts.isUndeletable,
            maxReadChars,
            media,
            onAdapterError: opts.onAdapterError,
          },
          tools,
        ),
      }
      if (skills !== undefined) contribution.skills = [fsSkillSource({ fs, ...skills })]
      return contribution
    },
  })
}
