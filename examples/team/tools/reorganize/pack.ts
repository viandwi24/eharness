#!/usr/bin/env bun
/**
 * Packs a reorganized workspace folder back into a zip the app can import.
 *
 *   bun tools/reorganize/pack.ts <unzipped workspace folder> [out.zip] [--force]
 *
 * Recomputes manifest.json (sha256, size and counts of every file) so nobody edits hashes by hand,
 * runs the validator first (errors stop it unless --force) and writes the zip with the server's own
 * zip writer. secrets.enc.json is copied byte for byte.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  bytesOf,
  canonicalJson,
  checkZipPath,
  classify,
  type ManifestFile,
  textOf,
} from '../../server/src/domain/workspace-export.ts'
import { zipFileWriter } from '../../server/src/infra/backup/zip-file.ts'
import { formatReport, MOVES_FILE, validateWorkspace } from './validate.ts'

const MEDIA: Record<string, string> = {
  md: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, base))
    else out.push(relative(base, path).split(sep).join('/'))
  }
  return out.sort()
}

const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export interface PackResult {
  files: number
  bytes: number
  counts: Record<string, number>
}

/** Rewrites manifest.json in memory and writes `out`. Throws on a path the app would refuse. */
export function packWorkspace(dir: string, out: string, now = Date.now()): PackResult {
  const old = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const oldFiles = new Map(
    (Array.isArray(old.files) ? (old.files as ManifestFile[]) : []).map((f) => [f.path, f]),
  )
  const paths = walk(dir).filter((p) => p !== 'manifest.json')
  const files: ManifestFile[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string, n = 1): void => {
    counts[key] = (counts[key] ?? 0) + n
  }
  const entries: Array<{ path: string; bytes: Uint8Array }> = []
  for (const path of paths) {
    if (path !== MOVES_FILE) {
      const problem = checkZipPath(path)
      if (problem !== undefined) throw new Error(`cannot pack: ${problem}`)
    }
    const bytes = new Uint8Array(readFileSync(join(dir, path)))
    entries.push({ path, bytes })
    const entry: ManifestFile = { path, size: bytes.byteLength, sha256: sha256(bytes) }
    const c = path === MOVES_FILE ? undefined : classify(path)
    if (c?.kind === 'file') {
      const before = oldFiles.get(path)
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      entry.mediaType = before?.mediaType ?? MEDIA[ext] ?? null
      entry.binary = before?.binary ?? !isUtf8(bytes)
      bump(c.section === 'memory' ? 'memoryFiles' : 'libraryFiles')
    } else if (c?.kind === 'agent') bump('agents')
    else if (c?.kind === 'program') bump('programs')
    else if (c?.kind === 'routine') bump('routines')
    else if (c?.kind === 'reminder') bump('reminders')
    else if (c?.kind === 'connection') bump('connections')
    else if (c?.kind === 'person') bump('people')
    else if (c?.kind === 'data' && c.table !== undefined) {
      let n = 0
      try {
        const rows = (JSON.parse(textOf(bytes)) as { rows?: unknown[] }).rows
        n = Array.isArray(rows) ? rows.length : 0
      } catch {}
      bump(c.table, n)
    }
    files.push(entry)
  }
  counts.libraryFiles = counts.libraryFiles ?? 0
  counts.memoryFiles = counts.memoryFiles ?? 0
  const secrets = entries.find((e) => e.path === 'secrets.enc.json')
  let secretCount = 0
  if (secrets !== undefined) {
    try {
      secretCount = Number((JSON.parse(textOf(secrets.bytes)) as { count?: number }).count ?? 0)
    } catch {}
    counts.secrets = secretCount
  }
  const manifest = {
    ...old,
    createdAt: now,
    counts,
    files,
    secrets: { included: secrets !== undefined, count: secretCount },
  }
  if (existsSync(out)) unlinkSync(out)
  const writer = zipFileWriter(out)
  try {
    writer.add('manifest.json', bytesOf(canonicalJson(manifest)), now)
    for (const e of entries) writer.add(e.path, e.bytes, now)
    writer.finish()
  } catch (error) {
    writer.abort()
    throw error
  }
  return { files: files.length, bytes: statSync(out).size, counts }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const force = process.argv.includes('--force')
  const dir = args[0]
  if (dir === undefined) {
    console.error(
      'usage: bun tools/reorganize/pack.ts <unzipped workspace folder> [out.zip] [--force]',
    )
    process.exit(2)
  }
  const report = validateWorkspace(dir)
  if (report.errors > 0 && !force) {
    console.error(formatReport(report))
    console.error('\nNot packed: fix the errors (or pass --force to pack anyway).')
    process.exit(1)
  }
  const out = resolve(args[1] ?? `${resolve(dir).replace(/\/+$/, '')}.reorganized.zip`)
  const result = packWorkspace(dir, out)
  console.log(`packed ${result.files} files (${result.bytes} bytes) into ${out}`)
  console.log('Next: Settings > Backups > Import from zip, and read the preview before applying.')
}
