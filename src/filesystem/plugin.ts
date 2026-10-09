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
import { joinPath, normalizePath, normalizePrefixes } from './paths.ts'
import { fsSkillSource } from './skill-source.ts'
import { createFileTools, DEFAULT_MEDIA_MAX_BYTES } from './tools.ts'
import type {
  FileChangeData,
  FileSystem,
  FilesystemOptions,
  FileToolName,
  ToolOutputStore,
} from './types.ts'
import { contentVersion } from './version.ts'

/** Default directory of the `toolOutputs` service. */
export const DEFAULT_TOOL_OUTPUTS_DIR = '/.eharness/tool-outputs'

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
      if (!result.ok) throw new Error(`toolOutputs: could not write ${path} (${result.reason})`)
      return path
    },
  }
}

/**
 * The filesystem plugin: provides the `fs` service (a {@link FileSystem}) and the `toolOutputs`
 * service, the file tools `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`,
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
 *       fs: memoryFs({ '/README.md': '# Hello\n' }),
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

  return definePlugin({
    name: 'filesystem',
    provides: outputsDir === undefined ? ['fs'] : ['fs', 'toolOutputs'],
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
                outputsDir !== undefined &&
                (path === outputsDir || path.startsWith(`${outputsDir}/`)),
              onError: (path, error) =>
                ctx.log.warn(`checkpoint of ${path} failed: ${String(error)}`),
            })
      const contribution: SessionContribution<FilesystemDataParts> = {
        services:
          outputsDir === undefined
            ? { fs: visible }
            : { fs: visible, toolOutputs: toolOutputStore(fs, outputsDir) },
        tools: createFileTools(
          {
            fs: visible,
            lastRead: lastReadOf(ctx.state),
            change: (data) => ctx.stream.data('change', data, { id: data.path }),
            hidden,
            readonly,
            unlisted: outputsDir === undefined ? [] : [outputsDir],
            allowedExtensions,
            isUndeletable: opts.isUndeletable,
            maxReadChars,
            media,
            onAdapterError: opts.onAdapterError,
          },
          tools,
        ),
      }
      if (skills !== undefined) contribution.skills = [fsSkillSource(fs, skills)]
      return contribution
    },
  })
}
