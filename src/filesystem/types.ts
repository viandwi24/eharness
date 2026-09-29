/**
 * The `FileSystem` contract (spec 08 §1), the `ToolOutputStore` service (spec 08 §2) and the
 * options of the `filesystem()` plugin.
 *
 * @see docs/specs/08-filesystem-plugin.md
 */
import type { HarnessContext } from '../index.ts'

/**
 * Metadata of one file.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export interface FileMeta {
  /** Normalized absolute POSIX path (`/src/main.pine`). */
  path: string
  /** Opaque; changes iff the content changes (use {@link contentVersion}). */
  version: string
  /** Size of the content in UTF-8 bytes. */
  size: number
  /** Last modification time (ms since epoch), when the adapter knows it. */
  updatedAt?: number
}

/**
 * A file with its text content.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export interface FileEntry extends FileMeta {
  /** UTF-8 text. */
  content: string
}

/**
 * Result of {@link FileSystem.write}. `'conflict'`: `ifVersion` was a string that does not match
 * (or the file is missing); `'exists'`: `ifVersion` was `null` and the file exists.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }

/**
 * Result of {@link FileSystem.delete}.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }

/**
 * One grep match.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export interface GrepHit {
  path: string
  /** 1-based line number. */
  line: number
  /** The matching line (without the line break). */
  text: string
}

/**
 * The storage contract of the filesystem plugin. Implement it for any backend (JSON file,
 * Postgres, S3, a sandbox disk) and check it with `fileSystemConformance` from
 * `eharness/testing`.
 *
 * Paths are normalized absolute POSIX paths (the plugin normalizes with {@link normalizePath}
 * before calling the adapter). Text only (UTF-8).
 *
 * @example
 * ```ts
 * const fs: FileSystem = memoryFs({ '/README.md': '# Hello\n' })
 * await fs.write('/a.md', 'x', { ifVersion: null }) // create only
 * ```
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export interface FileSystem {
  /** `null` if missing. */
  read(path: string): Promise<FileEntry | null>
  /**
   * Write text. `ifVersion`: string → only if the current version matches; `null` → only if the
   * file does not exist; `undefined` → unconditional.
   */
  write(path: string, content: string, opts?: { ifVersion?: string | null }): Promise<WriteResult>
  /** Delete a file. `ifVersion` → only if the current version matches. */
  delete(path: string, opts?: { ifVersion?: string }): Promise<DeleteResult>
  /**
   * Files whose path starts with `prefix` (default `'/'`), recursive, sorted by path (code unit
   * order). The plugin passes directory prefixes ending in `/` (or `'/'`).
   */
  list(prefix?: string): Promise<FileMeta[]>
  /** Optional fast path; the plugin falls back to `list` when absent. */
  stat?(path: string): Promise<FileMeta | null>
  /**
   * Optional fast path; the plugin falls back to `list` + `read` when absent. Hits sorted by
   * path, then line; at most `maxHits`.
   */
  grep?(pattern: RegExp, opts?: { prefix?: string; maxHits?: number }): Promise<GrepHit[]>
}

/**
 * The `toolOutputs` service: stores full tool outputs for `toolOutput.strategy: 'evict'`
 * (spec 09 §4).
 *
 * @see docs/specs/08-filesystem-plugin.md#2-plugin
 */
export interface ToolOutputStore {
  /** Store a full tool output; returns the path the model can read with `read_file`. */
  put(toolCallId: string, text: string): Promise<string>
}

/** Names of the file tools. */
export type FileToolName =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'grep'

/**
 * Payload of the `data-filesystem.change` part, written on every mutation (`id` = path).
 *
 * @see docs/specs/08-filesystem-plugin.md#5-data-part
 */
export interface FileChangeData {
  path: string
  action: 'create' | 'write' | 'edit' | 'delete'
  /** New version; `null` after a delete. */
  version: string | null
  /** New size in UTF-8 bytes (absent after a delete). */
  bytes?: number
}

/**
 * Options of {@link filesystem}.
 *
 * @see docs/specs/08-filesystem-plugin.md#2-plugin
 */
export interface FilesystemOptions {
  /**
   * Adapter instance, or a resolver called once per session at session open (e.g. one fs per
   * session/project).
   */
  fs: FileSystem | ((ctx: HarnessContext) => FileSystem | Promise<FileSystem>)
  /** Autoload skills from this fs (spec 07 §8). */
  skills?: { root: string; refresh?: 'session' | 'turn'; hideSkillsRoot?: boolean }
  /** Allowed extensions for writes (e.g. `['.md', '.pine']`). Default: any. */
  allowedExtensions?: string[]
  /** Read-only prefixes (writes/deletes rejected). */
  readonlyPrefixes?: string[]
  /** Hidden prefixes (invisible to all file tools). The skills root is added when `hideSkillsRoot`. */
  hiddenPrefixes?: string[]
  /** Files that may be edited but never deleted. */
  isUndeletable?: (path: string) => boolean
  /** Max characters returned by `read_file` per call. Default 50_000. */
  maxReadChars?: number
  /** Which tools to expose. Default all. */
  tools?: FileToolName[]
  /**
   * The `toolOutputs` service (evicted tool outputs, spec 09 §4). Default
   * `{ dir: '/.eharness/tool-outputs' }`; `false` disables the service.
   */
  toolOutputs?: false | { dir?: string }
}
