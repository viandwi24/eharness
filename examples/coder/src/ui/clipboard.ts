/** Read an image from the system clipboard (macOS `osascript`, Linux `wl-paste` / `xclip`). */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileUIPart } from 'ai'

/** Largest image taken from the clipboard. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 4000

/** Result of a spawned clipboard command. */
export interface RunResult {
  code: number | null
  stdout: Uint8Array
}

/** Runs a command with a timeout; resolves (never rejects) with the exit code. */
export type RunCommand = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>

/** Overridable parts of {@link readClipboardImage} (tests inject fakes). */
export interface ClipboardDeps {
  platform?: NodeJS.Platform
  run?: RunCommand
  readFile?: (path: string) => Promise<Uint8Array>
  /** Creates a unique temp file path; the second value removes it. */
  tempFile?: () => Promise<{ path: string; cleanup: () => Promise<void> }>
  timeoutMs?: number
  maxBytes?: number
  now?: () => number
}

/** Outcome of a clipboard read. */
export type ClipboardImage =
  | { ok: true; file: FileUIPart }
  | { ok: false; reason: 'none' | 'too-large' | 'unsupported' | 'error' }

/** Default {@link RunCommand}: `execFile` with a timeout and a byte cap. */
export const runCommand: RunCommand = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          timeout: timeoutMs,
          encoding: 'buffer',
          maxBuffer: MAX_IMAGE_BYTES * 2,
          windowsHide: true,
        },
        (error, stdout) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
          resolve({ code, stdout: stdout ?? new Uint8Array() })
        },
      )
    } catch {
      resolve({ code: null, stdout: new Uint8Array() })
    }
  })

const defaultTemp = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'coder-clip-'))
  return { path: join(dir, 'clip.png'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47

/** AppleScript lines that write the clipboard PNG to `path` (prints `none` when there is no image). */
export function macScript(path: string): string[] {
  const quoted = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return [
    'try',
    'set d to the clipboard as «class PNGf»',
    'on error',
    'return "none"',
    'end try',
    `set fh to open for access POSIX file "${quoted}" with write permission`,
    'set eof of fh to 0',
    'write d to fh',
    'close access fh',
    'return "ok"',
  ]
}

function toFile(bytes: Uint8Array, now: number): FileUIPart {
  return {
    type: 'file',
    mediaType: 'image/png',
    url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    filename: `clipboard-${now}.png`,
  }
}

/** Read a PNG from the clipboard. Never throws. */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardImage> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runCommand
  const read = deps.readFile ?? ((p: string) => readFile(p))
  const timeout = deps.timeoutMs ?? TIMEOUT_MS
  const max = deps.maxBytes ?? MAX_IMAGE_BYTES
  const now = (deps.now ?? Date.now)()
  const finish = (bytes: Uint8Array): ClipboardImage => {
    if (!isPng(bytes)) return { ok: false, reason: 'none' }
    if (bytes.length > max) return { ok: false, reason: 'too-large' }
    return { ok: true, file: toFile(bytes, now) }
  }
  try {
    if (platform === 'darwin') {
      const temp = await (deps.tempFile ?? defaultTemp)()
      try {
        const args = macScript(temp.path).flatMap((line) => ['-e', line])
        const res = await run('osascript', args, timeout)
        if (res.code !== 0 || new TextDecoder().decode(res.stdout).trim() !== 'ok') {
          return { ok: false, reason: 'none' }
        }
        return finish(await read(temp.path))
      } finally {
        await temp.cleanup().catch(() => {})
      }
    }
    if (platform === 'linux') {
      const attempts: Array<[string, string[]]> = [
        ['wl-paste', ['--type', 'image/png']],
        ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
      ]
      let failure: ClipboardImage = { ok: false, reason: 'none' }
      for (const [cmd, args] of attempts) {
        const res = await run(cmd, args, timeout)
        if (res.code !== 0) continue
        const out = finish(res.stdout)
        if (out.ok) return out
        failure = out
      }
      return failure
    }
    return { ok: false, reason: 'unsupported' }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
