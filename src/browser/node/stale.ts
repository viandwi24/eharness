/**
 * Leftovers of a hard crash (spec 35 §6): a Chrome profile lock whose owner is gone, and an engine
 * process this runtime started before it died. Both are cleaned on `start`, never while the owner
 * lives.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import { delay } from './process.ts'

/** The operating system calls of the cleanup; injectable for tests. */
export interface ProcessOs {
  /** Is the process alive? */
  alive(pid: number): boolean
  /** The command line of a process, or `undefined` when it cannot be read. */
  command(pid: number): Promise<string | undefined>
  /** Signal a process and its group. */
  kill(pid: number, signal: NodeJS.Signals): void
  hostname(): string
}

export const defaultProcessOs: ProcessOs = {
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  async command(pid) {
    if (process.platform === 'linux') {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
      } catch {
        return undefined
      }
    }
    if (process.platform === 'win32') return undefined
    return new Promise((resolve) => {
      execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (error, stdout) =>
        resolve(error === null && stdout.trim() !== '' ? stdout.trim() : undefined),
      )
    })
  },
  kill(pid, signal) {
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal)
    } catch {
      // not a group leader
    }
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  },
  hostname: () => osHostname(),
}

const CHROME_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']

/**
 * Remove the locks of a Chrome profile directory when their owner is gone. `SingletonLock` is a
 * symlink to `<host>-<pid>`: a dead pid or another host means no live Chrome holds the profile.
 * A lock of a live process on this host is left alone (Chrome then refuses to start, which is
 * the truth). Returns true when something was removed.
 */
export async function clearStaleChromeLocks(
  userDataDir: string,
  os: ProcessOs = defaultProcessOs,
): Promise<boolean> {
  let owner: { host: string; pid: number } | undefined
  let hasLock = true
  try {
    const target = await readlink(join(userDataDir, 'SingletonLock'))
    const at = target.lastIndexOf('-')
    const pid = Number(target.slice(at + 1))
    if (at > 0 && Number.isInteger(pid) && pid > 0) owner = { host: target.slice(0, at), pid }
  } catch {
    hasLock = false
  }
  if (hasLock && owner !== undefined && owner.host === os.hostname() && os.alive(owner.pid)) {
    return false
  }
  // no lock, an unreadable one, a dead owner or another host: nothing live holds these files
  let removed = false
  for (const name of CHROME_LOCKS) {
    const path = join(userDataDir, name)
    await rm(path, { force: true })
    removed = removed || hasLock
  }
  return removed
}

interface PidRecord {
  pid: number
  startedAt: number
}

/** Remember the engine process of a profile (a small JSON file). Best effort. */
export async function writePidFile(file: string, pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  try {
    await mkdir(dirname(file), { recursive: true })
    const record: PidRecord = { pid, startedAt: Date.now() }
    await writeFile(file, JSON.stringify(record))
  } catch {
    // the pid file only helps the next start
  }
}

export async function removePidFile(file: string): Promise<void> {
  await rm(file, { force: true })
}

/**
 * Kill the engine a previous run of this runtime left behind: the pid file names a process that is
 * alive and whose command line still contains `marker` (guards against a reused pid). The file is
 * removed either way. Returns true when a process was killed.
 */
export async function reapOrphan(
  file: string,
  marker: string,
  os: ProcessOs = defaultProcessOs,
  graceMs = 2000,
): Promise<boolean> {
  let record: PidRecord | undefined
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<PidRecord>
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      record = { pid: parsed.pid, startedAt: parsed.startedAt ?? 0 }
    }
  } catch {
    // no file or a broken one
  }
  await rm(file, { force: true })
  if (record === undefined || record.pid === process.pid || !os.alive(record.pid)) return false
  const command = await os.command(record.pid)
  if (command === undefined || !command.includes(marker)) return false
  os.kill(record.pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (os.alive(record.pid) && Date.now() < deadline) await delay(50)
  if (os.alive(record.pid)) os.kill(record.pid, 'SIGKILL')
  return true
}
