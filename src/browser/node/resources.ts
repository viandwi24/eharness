/**
 * Resource measurement for running engines (P48 owner decision: resources are visible).
 * Best effort: `null` when the platform or the process is unknown.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import type { ProcessUsage, SystemMemory } from './types.ts'

export interface ProcRow {
  pid: number
  ppid: number
  rssBytes: number
  cpuPercent: number
}

/** Parses `ps -A -o pid=,ppid=,rss=,%cpu=` (rss in KiB). */
export function parsePs(output: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s*$/.exec(line)
    if (m === null) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      cpuPercent: Number((m[4] as string).replace(',', '.')),
    })
  }
  return rows
}

/** Sums the process tree rooted at `rootPid`; `null` when the root is not in `rows`. */
export function sumTree(rows: ProcRow[], rootPid: number): ProcessUsage | null {
  if (!rows.some((r) => r.pid === rootPid)) return null
  const children = new Map<number, ProcRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  let rss = 0
  let cpu = 0
  const seen = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find((r) => r.pid === pid)
    if (row !== undefined) {
      rss += row.rssBytes
      cpu += row.cpuPercent
    }
    for (const child of children.get(pid) ?? []) queue.push(child.pid)
  }
  return { rssBytes: rss, cpuPercent: Math.round(cpu * 10) / 10 }
}

export interface UsageDeps {
  platform?: NodeJS.Platform
  /** Runs a command and returns stdout. */
  exec?: (command: string, args: string[]) => Promise<string>
  /** Reads a file as text (for /proc). */
  readText?: (path: string) => Promise<string>
  /** Lists /proc entries. */
  listProc?: () => Promise<string[]>
  now?: () => number
}

function defaultExec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    )
  })
}

const PAGE_SIZE = 4096
const CLOCK_TICKS = 100
/** Previous cumulative CPU ticks per pid, for a percent over the sampling interval. */
const cpuSamples = new Map<number, { ticks: number; at: number }>()

/** Parses /proc/<pid>/stat: `pid (comm) state ppid ... utime(14) stime(15) ... starttime(22)`. */
export function parseProcStat(
  text: string,
): { pid: number; ppid: number; ticks: number; startTicks: number } | null {
  const close = text.lastIndexOf(')')
  const open = text.indexOf('(')
  if (close < 0 || open < 0) return null
  const pid = Number(text.slice(0, open).trim())
  const f = text
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  // After the comm: f[0]=state f[1]=ppid ... f[11]=utime f[12]=stime ... f[19]=starttime
  const ppid = Number(f[1])
  const ticks = Number(f[11]) + Number(f[12])
  const startTicks = Number(f[19])
  if ([pid, ppid, ticks, startTicks].some((n) => !Number.isFinite(n))) return null
  return { pid, ppid, ticks, startTicks }
}

async function linuxRows(deps: UsageDeps): Promise<ProcRow[]> {
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'))
  const list = deps.listProc ?? (() => readdir('/proc'))
  const now = (deps.now ?? Date.now)()
  let uptime = 0
  try {
    uptime = Number((await readText('/proc/uptime')).split(' ')[0])
  } catch {
    // lifetime average unavailable
  }
  const rows: ProcRow[] = []
  const entries = (await list()).filter((e) => /^\d+$/.test(e))
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const stat = parseProcStat(await readText(`/proc/${entry}/stat`))
        if (stat === null) return
        const statm = (await readText(`/proc/${entry}/statm`)).split(' ')
        const rssBytes = Number(statm[1]) * PAGE_SIZE
        const prev = cpuSamples.get(stat.pid)
        let cpuPercent = 0
        if (prev !== undefined && now > prev.at) {
          cpuPercent = ((stat.ticks - prev.ticks) / CLOCK_TICKS / ((now - prev.at) / 1000)) * 100
        } else if (uptime > 0) {
          const alive = uptime - stat.startTicks / CLOCK_TICKS
          if (alive > 0) cpuPercent = (stat.ticks / CLOCK_TICKS / alive) * 100
        }
        cpuSamples.set(stat.pid, { ticks: stat.ticks, at: now })
        rows.push({
          pid: stat.pid,
          ppid: stat.ppid,
          rssBytes: Number.isFinite(rssBytes) ? rssBytes : 0,
          cpuPercent: Math.max(0, cpuPercent),
        })
      } catch {
        // process vanished between readdir and read
      }
    }),
  )
  return rows
}

/** RSS and CPU of `pid` and all its descendants. `null` when unknown (best effort). */
export async function processUsage(
  pid: number,
  deps: UsageDeps = {},
): Promise<ProcessUsage | null> {
  const platform = deps.platform ?? process.platform
  try {
    if (platform === 'linux') {
      const rows = await linuxRows(deps)
      const usage = sumTree(rows, pid)
      if (usage !== null) return usage
      // /proc unavailable (hidden pid namespace): fall back to ps.
    }
    if (platform === 'linux' || platform === 'darwin') {
      const exec = deps.exec ?? defaultExec
      return sumTree(parsePs(await exec('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu='])), pid)
    }
  } catch {
    // fall through
  }
  return null
}

export function systemMemory(): SystemMemory {
  return { totalBytes: totalmem(), freeBytes: freemem() }
}
