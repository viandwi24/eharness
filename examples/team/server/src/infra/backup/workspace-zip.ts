/**
 * The workspace zip: writing it (entity documents the app collected, then every library and memory
 * file streamed from a database, then `manifest.json` with the sha256 of everything) and reading it
 * back with every check an untrusted file needs (limits, entry names, hashes of the manifest).
 */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { invalid } from '../../domain/errors.ts'
import {
  bytesOf,
  canonicalJson,
  checkZipPath,
  classify,
  type EntityFile,
  entryOfFile,
  IMPORT_LIMITS,
  MANIFEST_NOTICE,
  MANIFEST_NOTICE_WITH_SECRETS,
  type ManifestFile,
  parseManifest,
  TOOL_MEDIA_PREFIX,
  textOf,
  WORKSPACE_FORMAT,
  WORKSPACE_FORMAT_VERSION,
  type WorkspaceManifest,
} from '../../domain/workspace-export.ts'
import { SECRETS_FILE, secretsHeader } from '../../domain/workspace-secrets.ts'
import { zipFileWriter } from './zip-file.ts'
import { readZip, ZipError } from './zip-reader.ts'

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

interface FileRow {
  path: string
  text: string | null
  bytes: Uint8Array | null
  media_type: string | null
  updated_at: number
}

export interface WriteResult {
  /** Library and memory files written. */
  files: number
  bytes: number
}

/**
 * Write the workspace export into `zipFile`: `entities` first, then the library and memory files of
 * `db` (a verified copy, or the live database: the read is one synchronous pass), then the manifest.
 * The caller owns `db`.
 */
export function writeWorkspaceZip(
  db: Database,
  zipFile: string,
  entities: readonly EntityFile[],
  options: { now: number; appVersion: string },
): WriteResult {
  const writer = zipFileWriter(zipFile)
  try {
    const slugs = new Map(
      db
        .query<{ id: string; slug: string }, []>('SELECT id, slug FROM agents')
        .all()
        .map((a) => [a.id, a.slug]),
    )
    const files: ManifestFile[] = []
    let secrets: WorkspaceManifest['secrets'] = { included: false, count: 0 }
    const counts: Record<string, number> = {}
    const bump = (key: string): void => {
      counts[key] = (counts[key] ?? 0) + 1
    }
    for (const e of entities) {
      const problem = checkZipPath(e.path)
      if (problem !== undefined) throw new Error(`the export would hold a bad entry: ${problem}`)
      writer.add(e.path, e.bytes, options.now)
      files.push({ path: e.path, size: e.bytes.byteLength, sha256: sha256(e.bytes) })
      const kind = classify(e.path)?.kind
      if (kind === 'agent') bump('agents')
      else if (kind === 'program') bump('programs')
      else if (kind === 'routine') bump('routines')
      else if (kind === 'reminder') bump('reminders')
      else if (kind === 'connection') bump('connections')
      else if (kind === 'person') bump('people')
      else if (kind === 'data') {
        const table = classify(e.path)?.table as string
        try {
          const rows = (JSON.parse(textOf(e.bytes)) as { rows?: unknown[] }).rows
          counts[table] = (counts[table] ?? 0) + (Array.isArray(rows) ? rows.length : 0)
        } catch {
          counts[table] = counts[table] ?? 0
        }
      } else if (e.path === SECRETS_FILE) {
        secrets = { included: true, count: secretsHeader(e.bytes).count }
        counts.secrets = secrets.count
      }
    }
    let skipped = 0
    let libraryFiles = 0
    let memoryFiles = 0
    for (const row of db
      .query<FileRow, []>(
        'SELECT path, text, bytes, media_type, updated_at FROM library_files ORDER BY path',
      )
      .iterate()) {
      // tool media is a cache of tool results, pruned in days: not part of the export
      if (row.path.startsWith(`${TOOL_MEDIA_PREFIX}/`)) {
        skipped++
        continue
      }
      const bytes = row.bytes ?? bytesOf(row.text ?? '')
      const entry = entryOfFile(row.path, slugs)
      const problem = checkZipPath(entry)
      if (problem !== undefined) throw new Error(`the export would hold a bad entry: ${problem}`)
      writer.add(entry, bytes, row.updated_at)
      files.push({
        path: entry,
        size: bytes.byteLength,
        sha256: sha256(bytes),
        mediaType: row.media_type,
        binary: row.bytes !== null,
      })
      if (classify(entry)?.section === 'memory') memoryFiles++
      else libraryFiles++
    }
    counts.libraryFiles = libraryFiles
    counts.memoryFiles = memoryFiles
    const manifest: WorkspaceManifest = {
      format: WORKSPACE_FORMAT,
      formatVersion: WORKSPACE_FORMAT_VERSION,
      app: { name: 'eharness-team', version: options.appVersion },
      createdAt: options.now,
      counts,
      files,
      excluded: skipped > 0 ? [{ prefix: TOOL_MEDIA_PREFIX, files: skipped }] : [],
      secrets,
      notice: secrets.included ? MANIFEST_NOTICE_WITH_SECRETS : MANIFEST_NOTICE,
    }
    writer.add('manifest.json', bytesOf(canonicalJson(manifest)), options.now)
    writer.finish()
    return { files: libraryFiles + memoryFiles, bytes: statSync(zipFile).size }
  } catch (error) {
    writer.abort()
    throw error
  }
}

/** Why a zip was refused, as the readable error an import answers with. */
const refused = (why: string): Error => invalid(`The zip was refused: ${why}`, 'IMPORT_REFUSED')

/**
 * Read and verify a workspace zip. Refused (with a readable reason): too large or too crowded, not a
 * zip, an entry name outside the expected folders or escaping them, a manifest that is missing or
 * not ours, a file whose hash differs from the manifest (tampered), a file the manifest does not
 * list, a listed file that is missing.
 */
export async function parseWorkspaceZip(
  bytes: Uint8Array,
): Promise<{ manifest: WorkspaceManifest; entries: Map<string, Uint8Array> }> {
  let all: Map<string, Uint8Array>
  try {
    all = await readZip(bytes, IMPORT_LIMITS)
  } catch (error) {
    if (error instanceof ZipError) throw refused(error.message)
    throw refused('it cannot be read as a zip file')
  }
  for (const name of all.keys()) {
    const problem = checkZipPath(name)
    if (problem !== undefined) throw refused(problem)
  }
  const rawManifest = all.get('manifest.json')
  if (rawManifest === undefined) throw refused('manifest.json is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(textOf(rawManifest))
  } catch {
    throw refused('manifest.json is not valid JSON')
  }
  const manifest = parseManifest(parsed)
  const listed = new Map<string, ManifestFile>()
  for (const f of manifest.files) {
    if (listed.has(f.path)) throw refused(`the manifest lists ${f.path} twice`)
    listed.set(f.path, f)
  }
  all.delete('manifest.json')
  for (const [path, content] of all) {
    const f = listed.get(path)
    if (f === undefined) throw refused(`${path} is in the zip but not in the manifest (tampered?)`)
    if (f.size !== content.byteLength || f.sha256 !== sha256(content)) {
      throw refused(`${path} does not match its hash in the manifest (tampered or corrupt)`)
    }
  }
  for (const path of listed.keys()) {
    if (!all.has(path)) throw refused(`${path} is listed in the manifest but missing from the zip`)
  }
  const secretsFile = all.get(SECRETS_FILE)
  if (secretsFile !== undefined) {
    let count: number
    try {
      count = secretsHeader(secretsFile).count
    } catch (error) {
      throw refused(error instanceof Error ? error.message : 'the secrets file is not readable')
    }
    if (!manifest.secrets.included || manifest.secrets.count !== count) {
      throw refused('the secrets file does not match what the manifest says about it (tampered?)')
    }
  } else if (manifest.secrets.included) {
    throw refused('the manifest says secrets are included but secrets.enc.json is missing')
  }
  return { manifest, entries: all }
}
