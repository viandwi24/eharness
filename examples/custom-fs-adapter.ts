/**
 * A custom `FileSystem` adapter over a key-value store, passing `fileSystemConformance`, used by
 * the `filesystem()` plugin.
 *
 *   bun examples/custom-fs-adapter.ts
 *
 * `KeyValueStore` is the smallest interface most stores offer (Redis, Workers KV, DynamoDB, a SQL
 * table). The in-memory `mapKeyValueStore()` stands in for it here. The rules that matter for any
 * adapter (spec 08 §1): normalized absolute paths (the plugin normalizes before calling),
 * `version` changes iff the content changes (use `contentVersion`), `size` in UTF-8 bytes,
 * conditional writes/deletes are atomic compare-and-set, listings sorted by path, copies out.
 */

import { defineHarnessAgent } from 'eharness'
import {
  contentVersion,
  type FileEntry,
  type FileMeta,
  type FileSystem,
  filesystem,
} from 'eharness/filesystem'
import { fileSystemConformance } from 'eharness/testing'
import { exampleModel } from './shared/model.ts'
import { keyedMutex } from './shared/mutex.ts'
import { runCases } from './shared/run-cases.ts'

/** A minimal key-value store. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** Keys that start with `prefix`, in any order. */
  keys(prefix: string): Promise<string[]>
}

/** In-memory `KeyValueStore` (stand-in for a real one). */
export function mapKeyValueStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
  }
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length
const byPath = (a: FileMeta, b: FileMeta): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * A `FileSystem` whose files are JSON records `{ content, version, size, updatedAt }` under
 * `<namespace>file:<path>`.
 *
 * Compare-and-set uses an in-process lock per path. With several processes, use the store's own
 * atomic primitive instead (Redis `WATCH`/`MULTI` or a Lua script, a DynamoDB condition
 * expression, `UPDATE … WHERE version = $1` in SQL).
 */
export function kvFileSystem(kv: KeyValueStore, options: { namespace?: string } = {}): FileSystem {
  const prefix = `${options.namespace ?? ''}file:`
  const exclusive = keyedMutex()

  const get = async (path: string): Promise<FileEntry | null> => {
    const raw = await kv.get(prefix + path)
    if (raw === null) return null
    const record = JSON.parse(raw) as Omit<FileEntry, 'path'>
    return { path, ...record } // parsed fresh: callers get a copy
  }
  const meta = ({ content: _content, ...rest }: FileEntry): FileMeta => rest

  return {
    read: get,
    async write(path, content, opts = {}) {
      return exclusive(path, async () => {
        const current = await get(path)
        if (opts.ifVersion === null && current !== null) {
          return { ok: false, reason: 'exists', currentVersion: current.version }
        }
        if (typeof opts.ifVersion === 'string' && current?.version !== opts.ifVersion) {
          return current === null
            ? { ok: false, reason: 'conflict' }
            : { ok: false, reason: 'conflict', currentVersion: current.version }
        }
        const version = await contentVersion(content)
        const record = { content, version, size: utf8Bytes(content), updatedAt: Date.now() }
        await kv.set(prefix + path, JSON.stringify(record))
        return { ok: true, version }
      })
    },
    async delete(path, opts = {}) {
      return exclusive(path, async () => {
        const current = await get(path)
        if (current === null) return { ok: false, reason: 'missing' }
        if (opts.ifVersion !== undefined && current.version !== opts.ifVersion) {
          return { ok: false, reason: 'conflict', currentVersion: current.version }
        }
        await kv.delete(prefix + path)
        return { ok: true }
      })
    },
    async list(dir = '/') {
      const keys = await kv.keys(prefix + dir)
      const entries = await Promise.all(keys.map((key) => get(key.slice(prefix.length))))
      return entries
        .filter((entry) => entry !== null)
        .map(meta)
        .sort(byPath)
    },
    async stat(path) {
      const entry = await get(path)
      return entry === null ? null : meta(entry)
    },
    // `grep` is optional: without it the plugin's grep tool falls back to list + read.
  }
}

if (import.meta.main) {
  await runCases(
    'FileSystem conformance (key-value store)',
    fileSystemConformance(() => kvFileSystem(mapKeyValueStore()), { requireStat: true }),
  )

  // The adapter behind the filesystem plugin: the model's file tools now write to the store.
  const kv = mapKeyValueStore()
  const agent = defineHarnessAgent({
    model: exampleModel([
      { toolCalls: [{ toolName: 'write_file', input: { path: '/hello.md', content: 'Hi!\n' } }] },
      { toolCalls: [{ toolName: 'list_files', input: {} }] },
      { text: 'Wrote /hello.md.' },
    ]),
    contextWindow: 200_000,
    plugins: [filesystem({ fs: kvFileSystem(kv, { namespace: 'tenant-1:' }) })],
  })
  const result = await agent.session('kv').send('Create /hello.md saying hi.').result
  console.log(`\nturn: ${result.stop}; store keys: ${(await kv.keys('')).join(', ')}`)
  await agent.close()
}
