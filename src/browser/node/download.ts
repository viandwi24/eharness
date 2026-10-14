/** Download, extract and install helpers for the Node runtimes (spec 35 §6). */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { runtimeError } from './process.ts'
import type { InstallProgress } from './types.ts'

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** Downloads `url` to `dest` through `<dest>.part` and an atomic rename; the part file is removed on failure. */
export async function downloadFile(opts: {
  fetch: FetchLike
  url: string
  dest: string
  signal?: AbortSignal
  onProgress?: (p: InstallProgress) => void
}): Promise<void> {
  const part = `${opts.dest}.part`
  await mkdir(dirname(opts.dest), { recursive: true })
  try {
    const res = await opts.fetch(opts.url, opts.signal === undefined ? {} : { signal: opts.signal })
    if (!res.ok || res.body === null) {
      throw runtimeError(`download failed: ${opts.url} answered ${res.status}`)
    }
    const header = Number(res.headers.get('content-length'))
    const total = Number.isFinite(header) && header > 0 ? header : undefined
    let received = 0
    const source = Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      opts.onProgress?.({ received, ...(total === undefined ? {} : { total }) })
    })
    await pipeline(
      source,
      createWriteStream(part),
      opts.signal === undefined ? {} : { signal: opts.signal },
    )
    if (total !== undefined && received !== total) {
      throw runtimeError(`download incomplete: ${received} of ${total} bytes`)
    }
    await rename(part, opts.dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error === null) resolve()
      else
        reject(runtimeError(`${command} failed: ${String(stderr).trim() || error.message}`, error))
    })
  })
}

/** Extracts a zip: `ditto` on macOS (keeps bundle metadata), `unzip` elsewhere, `tar` on Windows. */
export async function extractZip(zipPath: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (process.platform === 'darwin') {
    try {
      await run('ditto', ['-x', '-k', zipPath, dir])
      return
    } catch {
      // fall back to unzip
    }
  }
  if (process.platform === 'win32') {
    await run('tar', ['-xf', zipPath, '-C', dir])
    return
  }
  try {
    await run('unzip', ['-q', '-o', zipPath, '-d', dir])
  } catch (error) {
    throw runtimeError(
      `could not extract ${zipPath}: the system "unzip" is required (${String(error)})`,
      error,
    )
  }
}

export async function makeExecutable(path: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, 0o755)
}

/** Removes the macOS quarantine attribute from a downloaded file or bundle. Best effort. */
export async function removeQuarantine(path: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await run('xattr', ['-dr', 'com.apple.quarantine', path])
  } catch {
    // the attribute may be absent
  }
}

/** Recursive size of a path in bytes (0 when missing). */
export async function diskUsage(path: string): Promise<number> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return info.size
    let sum = 0
    for (const name of await readdir(path)) sum += await diskUsage(join(path, name))
    return sum
  } catch {
    return 0
  }
}

const locks = new Map<string, Promise<void>>()

/** One install at a time per key: a second caller waits for the first and shares its outcome. */
export function withInstallLock(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = locks.get(key)
  if (existing !== undefined) return existing
  const promise = fn().finally(() => {
    locks.delete(key)
  })
  locks.set(key, promise)
  return promise
}
