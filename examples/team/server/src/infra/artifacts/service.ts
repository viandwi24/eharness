/**
 * Artifacts (docs/plans/P45-team-artifacts.md): records, versions, content and the signed URLs of
 * the content routes. The files live in the Library (`/library/artifacts/<slug>-<id>/`, or an
 * adopted folder); a version is a snapshot of the folder kept in `artifact_blobs` by content hash,
 * because the library history keeps metadata only.
 *
 * Plain SQL on the shared connection (like `library-fs.ts`).
 */
import type { Database } from 'bun:sqlite'
import type { FileSystem } from 'eharness/filesystem'
import {
  type ArtifactFileInfo,
  baseMediaType,
  extOf,
  kindOf,
  mediaTypeOf,
  pickEntry,
  validateArtifact,
} from '../../../../shared/artifacts/kinds.ts'
import type { ArtifactsPort } from '../../app/ports.ts'
import {
  ARTIFACT_LIMITS,
  type Artifact,
  type ArtifactExport,
  type ArtifactFileView,
  type ArtifactPatch,
  type ArtifactShare,
  type ArtifactSummary,
  type ArtifactVersionView,
  type NewArtifact,
  type SignedUrl,
} from '../../domain/artifacts.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import { type LibraryChange, libraryFs } from '../eh/library-fs.ts'
import { markdownToHtml } from './markdown.ts'
import { createSigner, randomToken, type Signer } from './signing.ts'
import { zip } from './zip.ts'

export interface ArtifactRow {
  id: string
  kind: string
  title: string
  description: string
  dir: string
  entry: string
  agent_id: string | null
  session_id: string | null
  version: number
  visibility: 'private' | 'public'
  share_token: string | null
  share_version: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

interface VersionRow {
  artifact_id: string
  n: number
  files: string
  entry: string
  note: string
  by: string
  at: number
}

type FileMap = Record<string, { hash: string; size: number }>

export interface ArtifactServiceOptions {
  sqlite: Database
  /** Epoch ms. */
  now: () => number
  /** A fresh sortable id (UUIDv7). */
  nextId: () => string
  /** Where the web app lives (`<web>/artifacts/<id>`, `<web>/s/<token>`). */
  webUrl: string
  /** Where content is served: `TEAM_ARTIFACT_URL`, else this server's public URL. */
  contentUrl: string
  /** HMAC secret of the signed URLs. */
  secret: string
  /** Library change feed hook, passed on to the filesystem the service writes with. */
  onFileChange?: ((change: LibraryChange) => void) | undefined
}

/** Who writes: an agent (its filesystem) or a person in the web app. */
export interface Actor {
  by: string
  agentId: string | null
  sessionId?: string | null
}

export interface CreateContext {
  actor: Actor
  /** The filesystem to write with (default: the library as `actor.agentId`). */
  fs?: FileSystem
  /** Path authority of a program run: undefined = unrestricted. */
  access?: { canRead(path: string): boolean; canWrite(path: string): boolean } | undefined
}

export interface SnapshotResult {
  /** The new version number; null when nothing changed. */
  n: number | null
  problems: string[]
}

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'artifact'

/** A relative artifact file path: no `..`, no leading slash, no control characters. */
export function checkRelativePath(raw: string): string {
  const path = raw.trim().replace(/^\.\//, '')
  if (
    path === '' ||
    path.length > 200 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in paths
    /[\\\u0000-\u001f]/.test(path)
  ) {
    throw invalid(`invalid artifact file path: ${raw}`, 'INVALID_PATH')
  }
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw invalid(`invalid artifact file path: ${raw}`, 'INVALID_PATH')
    }
  }
  return path
}

/** A library folder for an artifact: absolute, under /library, at least one level below it. */
export function checkDir(raw: string): string {
  const dir = raw.trim().replace(/\/+$/, '')
  if (!dir.startsWith('/library/') || dir.length > 300) {
    throw invalid(
      'the folder must be inside /library (for example /library/work/chart)',
      'INVALID_PATH',
    )
  }
  for (const seg of dir.split('/').slice(1)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in paths
    if (seg === '' || seg === '.' || seg === '..' || /[\\\u0000-\u001f]/.test(seg)) {
      throw invalid(`invalid folder: ${raw}`, 'INVALID_PATH')
    }
  }
  if (dir === '/library/artifacts' || dir.split('/').length < 3) {
    throw invalid(
      'use a folder below /library, not /library or /library/artifacts itself',
      'INVALID_PATH',
    )
  }
  return dir
}

const isTextType = (mediaType: string): boolean => {
  const t = baseMediaType(mediaType)
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'image/svg+xml' ||
    t === 'application/javascript'
  )
}

const b64decode = (s: string): Uint8Array => {
  try {
    const bin = atob(s.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    throw invalid('base64 content is not valid base64', 'INVALID_BASE64')
  }
}

export interface ArtifactService extends ArtifactsPort {
  /** Create an artifact (agents and the web alike); snapshots version 1. */
  createWith(
    input: NewArtifact,
    context: CreateContext,
  ): Promise<{ artifact: Artifact; problems: string[] }>
  /** A library file changed: mark the artifacts that contain it dirty. */
  onLibraryChange(change: LibraryChange): void
  /** Snapshot the artifacts the agent changed since the last snapshot (end of turn). */
  snapshotDirty(
    agentId: string | null,
  ): Promise<Array<{ id: string; title: string; n: number | null; problems: string[] }>>
  /** Snapshot one artifact now. */
  snapshot(id: string, by: string, note?: string, force?: boolean): Promise<SnapshotResult>
  /** Raw row (agent tools). */
  row(id: string): ArtifactRow | undefined
  /** Change visibility with an actor (audit); the web patch uses it too. */
  setVisibility(
    id: string,
    visibility: 'private' | 'public',
    actor: string,
    opts?: { shareVersion?: number | null; sessionId?: string | null },
  ): Artifact
  /** The in-app page of an artifact. */
  appUrl(id: string): string
  /** Content of a version of an artifact: `path` empty = the entry. */
  contentOfVersion(id: string, version: number, path: string): ContentResult
  /** Content of the shared version, by share token. */
  contentOfShare(token: string, path: string): ContentResult
  /** Verify a signed token of the content routes. */
  verifyView(id: string, version: number, token: string): Promise<boolean>
  verifyLibrary(path: string, token: string): Promise<boolean>
  /** A library file for a signed raw view. */
  contentOfLibrary(path: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  /** Rows for `artifact_list` (agents). */
  search(query: {
    query?: string | undefined
    kind?: string | undefined
    limit: number
  }): ArtifactSummary[]
  event(
    id: string,
    action: string,
    actor: string,
    detail: Record<string, unknown>,
    sessionId?: string | null,
  ): void
}

export type ContentResult = { bytes: Uint8Array; mediaType: string; path: string } | undefined

export function createArtifactService(options: ArtifactServiceOptions): ArtifactService {
  const { sqlite } = options
  const signer: Signer = createSigner(options.secret)
  const web = options.webUrl.replace(/\/$/, '')
  const content = options.contentUrl.replace(/\/$/, '')
  const dirty = new Map<string, { agentId: string | null }>()
  const locks = new Map<string, Promise<unknown>>()

  const fsOf = (agentId: string | null): FileSystem =>
    libraryFs(sqlite, {
      ...(agentId === null ? {} : { agentId }),
      ...(options.onFileChange === undefined ? {} : { onChange: options.onFileChange }),
    })

  const rowOf = (id: string): ArtifactRow | undefined =>
    sqlite
      .query<ArtifactRow, [string]>('SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL')
      .get(id) ?? undefined

  const need = (id: string): ArtifactRow => {
    const row = rowOf(id)
    if (row === undefined) throw notFound('artifact', id)
    return row
  }

  const shareUrlOf = (row: ArtifactRow): string | null =>
    row.visibility === 'public' && row.share_token !== null ? `${web}/s/${row.share_token}` : null

  const summaryOf = (row: ArtifactRow): ArtifactSummary => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    dir: row.dir,
    entry: row.entry,
    agentId: row.agent_id,
    sessionId: row.session_id,
    version: row.version,
    visibility: row.visibility,
    shareUrl: shareUrlOf(row),
    shareVersion: row.share_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const versionRow = (id: string, n: number): VersionRow | undefined =>
    sqlite
      .query<VersionRow, [string, number]>(
        'SELECT * FROM artifact_versions WHERE artifact_id = ? AND n = ?',
      )
      .get(id, n) ?? undefined

  const filesOfVersion = (v: VersionRow | undefined): ArtifactFileView[] => {
    if (v === undefined) return []
    const map = JSON.parse(v.files) as FileMap
    return Object.entries(map)
      .map(([path, f]) => ({
        path,
        size: f.size,
        mediaType: baseMediaType(mediaTypeOf(path)) || 'application/octet-stream',
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
  }

  const viewOf = (row: ArtifactRow): Artifact => ({
    ...summaryOf(row),
    files: filesOfVersion(versionRow(row.id, row.version)),
  })

  const event = (
    id: string,
    action: string,
    actor: string,
    detail: Record<string, unknown>,
    sessionId?: string | null,
  ): void => {
    sqlite
      .query(
        'INSERT INTO artifact_events (artifact_id, action, actor, session_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, action, actor, sessionId ?? null, JSON.stringify(detail), options.now())
  }

  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(id, next)
    const clear = (): void => {
      if (locks.get(id) === next) locks.delete(id)
    }
    next.then(clear, clear)
    return next
  }

  // --- snapshots -----------------------------------------------------------------------------

  async function takeSnapshot(
    row: ArtifactRow,
    by: string,
    note: string,
    force: boolean,
    fs: FileSystem,
  ): Promise<SnapshotResult> {
    const prefix = `${row.dir}/`
    const metas = (await fs.list(prefix)).filter((m) => m.path.startsWith(prefix))
    const problems: string[] = []
    if (metas.length > ARTIFACT_LIMITS.maxFiles) {
      return {
        n: null,
        problems: [
          `The artifact has ${metas.length} files; the limit is ${ARTIFACT_LIMITS.maxFiles}.`,
        ],
      }
    }
    const files: FileMap = {}
    let total = 0
    for (const m of metas) {
      if (m.size > ARTIFACT_LIMITS.maxFileBytes) {
        problems.push(
          `${m.path.slice(prefix.length)} is ${Math.round(m.size / 1024)} KB; the limit is ${ARTIFACT_LIMITS.maxFileBytes / 1024 / 1024} MB per file. Make it smaller or remove it.`,
        )
        continue
      }
      total += m.size
      files[m.path.slice(prefix.length)] = { hash: m.version, size: m.size }
    }
    if (total > ARTIFACT_LIMITS.maxArtifactBytes) {
      return {
        n: null,
        problems: [
          `The artifact is ${Math.round(total / 1024 / 1024)} MB; the limit is ${ARTIFACT_LIMITS.maxArtifactBytes / 1024 / 1024} MB in all.`,
        ],
      }
    }
    const latest = versionRow(row.id, row.version)
    const same =
      latest !== undefined &&
      !force &&
      JSON.stringify(Object.entries(JSON.parse(latest.files) as FileMap).sort()) ===
        JSON.stringify(Object.entries(files).sort())
    // the entry may have moved with a rename of the file (an agent edit): keep following the kind's pick
    let entry = row.entry
    if (files[entry] === undefined) {
      const picked = pickEntry(row.kind, Object.keys(files))
      if (picked !== undefined && Object.keys(files).length > 0) entry = picked
    }
    if (same && entry === row.entry) return { n: null, problems: [] }

    // blobs: copy-on-write by hash
    const have = sqlite.query<{ hash: string }, [string]>(
      'SELECT hash FROM artifact_blobs WHERE hash = ?',
    )
    const put = sqlite.query(
      'INSERT OR IGNORE INTO artifact_blobs (hash, bytes, media_type, size) VALUES (?, ?, ?, ?)',
    )
    const infos: ArtifactFileInfo[] = []
    for (const [rel, f] of Object.entries(files)) {
      const mediaType = mediaTypeOf(rel)
      let text: string | undefined
      let bytes: Uint8Array | undefined
      const stored = have.get(f.hash) !== null
      const needText = isTextType(mediaType) && f.size <= 512 * 1024
      if (!stored || needText) {
        const read = await fs.readBytes?.(`${prefix}${rel}`)
        if (read === undefined || read === null) continue
        bytes = read.bytes
        if (!stored) put.run(f.hash, bytes, mediaType, f.size)
        if (needText) text = decoder.decode(bytes)
      }
      infos.push({ path: rel, size: f.size, mediaType, text })
    }
    problems.push(...validateArtifact(row.kind, infos, entry))

    const n = row.version + 1
    sqlite.transaction(() => {
      sqlite
        .query(
          'INSERT INTO artifact_versions (artifact_id, n, files, entry, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, n, JSON.stringify(files), entry, note, by, options.now())
      sqlite
        .query('UPDATE artifacts SET version = ?, entry = ?, updated_at = ? WHERE id = ?')
        .run(n, entry, options.now(), row.id)
      // keep the newest versions; blobs nobody uses any more go with them
      const old = sqlite
        .query<{ n: number }, [string, number]>(
          'SELECT n FROM artifact_versions WHERE artifact_id = ? ORDER BY n DESC LIMIT -1 OFFSET ?',
        )
        .all(row.id, ARTIFACT_LIMITS.maxVersions)
      for (const o of old) {
        sqlite
          .query('DELETE FROM artifact_versions WHERE artifact_id = ? AND n = ?')
          .run(row.id, o.n)
      }
      if (old.length > 0) pruneBlobs()
    })()
    event(row.id, 'version', by, {
      n,
      note,
      files: Object.keys(files).length,
      problems: problems.length,
    })
    return { n, problems }
  }

  /** Delete blobs no version references (after pruning old versions). */
  function pruneBlobs(): void {
    const used = new Set<string>()
    for (const v of sqlite
      .query<{ files: string }, []>('SELECT files FROM artifact_versions')
      .all()) {
      for (const f of Object.values(JSON.parse(v.files) as FileMap)) used.add(f.hash)
    }
    for (const b of sqlite.query<{ hash: string }, []>('SELECT hash FROM artifact_blobs').all()) {
      if (!used.has(b.hash)) sqlite.query('DELETE FROM artifact_blobs WHERE hash = ?').run(b.hash)
    }
  }

  const snapshot: ArtifactService['snapshot'] = (id, by, note = '', force = false) =>
    serial(id, async () => {
      const row = rowOf(id)
      if (row === undefined) return { n: null, problems: [] }
      return takeSnapshot(row, by, note, force, fsOf(by.startsWith('agent:') ? by.slice(6) : null))
    })

  // --- content -------------------------------------------------------------------------------

  function blobOf(hash: string): { bytes: Uint8Array } | undefined {
    const b = sqlite
      .query<{ bytes: Uint8Array }, [string]>('SELECT bytes FROM artifact_blobs WHERE hash = ?')
      .get(hash)
    return b === null ? undefined : { bytes: new Uint8Array(b.bytes) }
  }

  function contentOfVersion(id: string, version: number, path: string): ContentResult {
    const row = rowOf(id)
    if (row === undefined) return undefined
    const v = versionRow(id, version)
    if (v === undefined) return undefined
    const files = JSON.parse(v.files) as FileMap
    const rel = path === '' ? v.entry : path
    const file = files[rel]
    if (file === undefined) return undefined
    const blob = blobOf(file.hash)
    if (blob === undefined) return undefined
    return { bytes: blob.bytes, mediaType: mediaTypeOf(rel), path: rel }
  }

  function contentOfShare(token: string, path: string): ContentResult {
    const row = sqlite
      .query<ArtifactRow, [string]>(
        "SELECT * FROM artifacts WHERE share_token = ? AND visibility = 'public' AND deleted_at IS NULL",
      )
      .get(token)
    if (row === null) return undefined
    return contentOfVersion(row.id, row.share_version ?? row.version, path)
  }

  // --- create --------------------------------------------------------------------------------

  async function createWith(
    input: NewArtifact,
    context: CreateContext,
  ): Promise<{ artifact: Artifact; problems: string[] }> {
    const title = input.title.trim()
    if (title === '' || title.length > 200)
      throw invalid('title is required (at most 200 characters)', 'INVALID_TITLE')
    if ((input.description ?? '').length > 2000)
      throw invalid('description is longer than 2000 characters')
    const kind = kindOf(input.kind).id
    const fs = context.fs ?? fsOf(context.actor.agentId)
    const id = options.nextId()
    let dir: string
    if (input.dir !== undefined && input.dir.trim() !== '') {
      dir = checkDir(input.dir)
      const taken = sqlite
        .query<{ id: string }, [string]>(
          'SELECT id FROM artifacts WHERE dir = ? AND deleted_at IS NULL',
        )
        .get(dir)
      if (taken !== null)
        throw conflict(`${dir} is already the folder of artifact ${taken.id}`, 'ARTIFACT_EXISTS', {
          id: taken.id,
        })
    } else {
      dir = `/library/artifacts/${slugOf(title)}-${id.replace(/-/g, '').slice(-6)}`
    }

    // write the given files
    let total = 0
    const written = new Set<string>()
    for (const f of input.files ?? []) {
      const sources = [f.content, f.base64, f.from].filter((s) => s !== undefined).length
      if (sources !== 1)
        throw invalid('each file needs exactly one of content, base64 or from', 'INVALID_FILE')
      let bytes: Uint8Array
      let rel: string
      if (f.from !== undefined) {
        const from = f.from.trim()
        if (!from.startsWith('/') || from.startsWith('/memories')) {
          throw invalid(
            `from must be a library file path like /library/work/chart.png: ${from}`,
            'INVALID_PATH',
          )
        }
        if (context.access !== undefined && !context.access.canRead(from)) {
          throw invalid(`not allowed to read ${from}`, 'NOT_ALLOWED')
        }
        const read = await fs.readBytes?.(from)
        if (read === undefined || read === null) throw notFound('file', from)
        bytes = read.bytes
        rel = checkRelativePath(f.path ?? from.slice(from.lastIndexOf('/') + 1))
      } else if (f.base64 !== undefined) {
        bytes = b64decode(f.base64)
        rel = checkRelativePath(f.path ?? '')
      } else {
        bytes = encoder.encode(f.content as string)
        rel = checkRelativePath(f.path ?? '')
      }
      if (bytes.byteLength > ARTIFACT_LIMITS.maxFileBytes) {
        throw invalid(
          `${rel} is larger than ${ARTIFACT_LIMITS.maxFileBytes / 1024 / 1024} MB`,
          'FILE_TOO_LARGE',
        )
      }
      total += bytes.byteLength
      if (total > ARTIFACT_LIMITS.maxArtifactBytes) {
        throw invalid(
          `the files are larger than ${ARTIFACT_LIMITS.maxArtifactBytes / 1024 / 1024} MB in all`,
          'FILE_TOO_LARGE',
        )
      }
      const target = `${dir}/${rel}`
      if (context.access !== undefined && !context.access.canWrite(target)) {
        throw invalid(`not allowed to write ${target}`, 'NOT_ALLOWED')
      }
      const mediaType = mediaTypeOf(rel)
      const result =
        f.content !== undefined
          ? await fs.write(target, f.content)
          : await fs.writeBytes?.(target, bytes, {
              mediaType:
                mediaType === 'application/octet-stream' ? undefined : baseMediaType(mediaType),
            })
      if (result === undefined || !result.ok)
        throw invalid(`could not write ${target}`, 'WRITE_FAILED')
      written.add(rel)
    }

    const existing = (await fs.list(`${dir}/`)).filter((m) => m.path.startsWith(`${dir}/`))
    if (existing.length === 0) {
      throw invalid(
        input.dir === undefined
          ? 'an artifact needs at least one file'
          : `${dir} has no files to adopt`,
        'NO_FILES',
      )
    }
    const rels = existing.map((m) => m.path.slice(dir.length + 1))
    const entry = pickEntry(kind, rels, input.entry?.trim() === '' ? undefined : input.entry)
    if (entry === undefined) {
      throw invalid(
        `the entry file ${input.entry ?? ''} is not among the files (${rels.slice(0, 8).join(', ')})`,
        'INVALID_ENTRY',
      )
    }
    const now = options.now()
    sqlite
      .query(
        `INSERT INTO artifacts (id, kind, title, description, dir, entry, agent_id, session_id, version, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'private', ?, ?)`,
      )
      .run(
        id,
        kind,
        title,
        (input.description ?? '').trim(),
        dir,
        entry,
        context.actor.agentId,
        context.actor.sessionId ?? input.origin?.sessionId ?? null,
        now,
        now,
      )
    event(
      id,
      'create',
      context.actor.by,
      { kind, dir, entry, ...(input.origin === undefined ? {} : { origin: input.origin }) },
      context.actor.sessionId,
    )
    const snap = await snapshot(id, context.actor.by, 'created', true)
    dirty.delete(id)
    return { artifact: viewOf(need(id)), problems: snap.problems }
  }

  // --- patch, visibility, delete -------------------------------------------------------------

  function setVisibility(
    id: string,
    visibility: 'private' | 'public',
    actor: string,
    opts: { shareVersion?: number | null; sessionId?: string | null } = {},
  ): Artifact {
    const row = need(id)
    let shareVersion = row.share_version
    if (opts.shareVersion !== undefined) {
      if (opts.shareVersion !== null && versionRow(id, opts.shareVersion) === undefined) {
        throw invalid(`artifact ${id} has no version ${opts.shareVersion}`, 'NO_SUCH_VERSION')
      }
      shareVersion = opts.shareVersion
    }
    if (visibility === 'public') {
      // private -> public always issues a new token; a pin on a public artifact keeps the link
      const token =
        row.visibility === 'public' && row.share_token !== null ? row.share_token : randomToken()
      sqlite
        .query(
          "UPDATE artifacts SET visibility = 'public', share_token = ?, share_version = ?, updated_at = ? WHERE id = ?",
        )
        .run(token, shareVersion, options.now(), id)
    } else {
      sqlite
        .query(
          "UPDATE artifacts SET visibility = 'private', share_token = NULL, share_version = NULL, updated_at = ? WHERE id = ?",
        )
        .run(options.now(), id)
    }
    if (
      row.visibility !== visibility ||
      row.share_version !== (visibility === 'public' ? shareVersion : null)
    ) {
      event(
        id,
        'visibility',
        actor,
        {
          from: row.visibility,
          to: visibility,
          shareVersion: visibility === 'public' ? shareVersion : null,
        },
        opts.sessionId,
      )
    }
    return viewOf(need(id))
  }

  // --- exports -------------------------------------------------------------------------------

  const csvCell = (v: unknown): string => {
    const s =
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"'
            i++
          } else quoted = false
        } else cell += c
      } else if (c === '"') quoted = true
      else if (c === ',') {
        row.push(cell)
        cell = ''
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++
        row.push(cell)
        cell = ''
        if (row.length > 1 || row[0] !== '') rows.push(row)
        row = []
      } else cell += c
    }
    if (cell !== '' || row.length > 0) {
      row.push(cell)
      rows.push(row)
    }
    return rows
  }

  async function exportOf(id: string, format: string, version?: number): Promise<ArtifactExport> {
    const row = need(id)
    const n = version ?? row.version
    const v = versionRow(id, n)
    if (v === undefined) throw notFound('version', `${id}@${n}`)
    const kind = kindOf(row.kind)
    const def =
      kind.exports.find((e) => e.id === format) ??
      (format === 'zip'
        ? { id: 'zip', label: 'ZIP', mediaType: 'application/zip', ext: 'zip' }
        : undefined)
    if (def === undefined) {
      throw invalid(
        `${row.kind} artifacts export as ${[...kind.exports.map((e) => e.id), 'zip'].join(', ')}, not ${format}`,
        'UNKNOWN_FORMAT',
      )
    }
    if ('client' in def && def.client === true) {
      throw invalid(
        `${format} is produced in the browser (open the artifact and use Export there)`,
        'CLIENT_FORMAT',
      )
    }
    const base = slugOf(row.title)
    const entryContent = contentOfVersion(id, n, '')
    if (entryContent === undefined) throw notFound('artifact content', id)
    const finish = (bytes: Uint8Array, mediaType: string, ext: string): ArtifactExport => {
      event(id, 'export', 'web', { format, version: n })
      return { bytes, mediaType, filename: `${base}.${ext}` }
    }
    if (format === 'zip') {
      const files = Object.keys(JSON.parse(v.files) as FileMap).flatMap((rel) => {
        const c = contentOfVersion(id, n, rel)
        return c === undefined ? [] : [{ path: rel, bytes: c.bytes }]
      })
      return finish(zip(files, row.updated_at), 'application/zip', 'zip')
    }
    const text = decoder.decode(entryContent.bytes)
    const entryExt = extOf(v.entry).slice(1)
    if (row.kind === 'document' && format === 'html') {
      return finish(
        encoder.encode(markdownToHtml(text, row.title)),
        'text/html; charset=utf-8',
        'html',
      )
    }
    if (row.kind === 'data' && (format === 'csv' || format === 'json')) {
      const isJson = extOf(v.entry) === '.json'
      if (format === 'json' && !isJson) {
        const [head = [], ...rest] = parseCsv(text)
        const out = rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
        return finish(
          encoder.encode(JSON.stringify(out, null, 2)),
          'application/json; charset=utf-8',
          'json',
        )
      }
      if (format === 'csv' && isJson) {
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          throw invalid('the data file is not valid JSON', 'INVALID_DATA')
        }
        const rows = Array.isArray(data) ? data : [data]
        const cols = [
          ...new Set(
            rows.flatMap((r) => (r !== null && typeof r === 'object' ? Object.keys(r) : [])),
          ),
        ]
        if (cols.length === 0)
          throw invalid('the JSON has no object rows to turn into CSV', 'INVALID_DATA')
        const lines = [
          cols.map(csvCell).join(','),
          ...rows.map((r) => cols.map((c) => csvCell((r as Record<string, unknown>)[c])).join(',')),
        ]
        return finish(encoder.encode(`${lines.join('\n')}\n`), 'text/csv; charset=utf-8', 'csv')
      }
    }
    // the entry as it is
    return finish(
      entryContent.bytes,
      def.mediaType === '' ? entryContent.mediaType : entryContent.mediaType,
      entryExt || def.ext || 'bin',
    )
  }

  // --- listing -------------------------------------------------------------------------------

  const like = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

  function rows(query: {
    query?: string | undefined
    kind?: string | undefined
    agentId?: string | undefined
    limit: number
    cursor?: string | undefined
  }): ArtifactRow[] {
    const where = ['deleted_at IS NULL']
    const params: Array<string | number> = []
    if (query.kind !== undefined && query.kind !== '') {
      where.push('kind = ?')
      params.push(query.kind)
    }
    if (query.agentId !== undefined && query.agentId !== '') {
      where.push('agent_id = ?')
      params.push(query.agentId)
    }
    if (query.query !== undefined && query.query.trim() !== '') {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
      params.push(like(query.query.trim()), like(query.query.trim()))
    }
    if (query.cursor !== undefined && query.cursor !== '') {
      const [at, cid] = query.cursor.split(':')
      if (at !== undefined && cid !== undefined && Number.isFinite(Number(at))) {
        where.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
        params.push(Number(at), Number(at), cid)
      }
    }
    return sqlite
      .query<ArtifactRow, Array<string | number>>(
        `SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, query.limit + 1)
  }

  // --- the port ------------------------------------------------------------------------------

  const service: ArtifactService = {
    list(query) {
      const found = rows(query)
      const page = found.slice(0, query.limit)
      const last = page[page.length - 1]
      return {
        items: page.map(summaryOf),
        nextCursor:
          found.length > query.limit && last !== undefined ? `${last.updated_at}:${last.id}` : null,
      }
    },
    search(query) {
      return rows(query).slice(0, query.limit).map(summaryOf)
    },
    get: (id) => {
      const row = rowOf(id)
      return row === undefined ? undefined : viewOf(row)
    },
    row: rowOf,
    versions(id) {
      if (rowOf(id) === undefined) return undefined
      return sqlite
        .query<VersionRow, [string]>(
          'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY n DESC',
        )
        .all(id)
        .map(
          (v): ArtifactVersionView => ({
            n: v.n,
            note: v.note,
            by: v.by,
            at: v.at,
            entry: v.entry,
            files: filesOfVersion(v),
          }),
        )
    },
    async viewUrl(id, opts) {
      const row = need(id)
      const version = opts.version ?? row.version
      const v = versionRow(id, version)
      if (v === undefined) throw notFound('version', `${id}@${version}`)
      const path =
        opts.path === undefined || opts.path === '' ? v.entry : checkRelativePath(opts.path)
      if (!(path in (JSON.parse(v.files) as FileMap))) throw notFound('file', path)
      const expiresAt = options.now() + ARTIFACT_LIMITS.viewUrlTtlMs
      const token = await signer.sign(`v|${id}|${version}`, expiresAt)
      const encoded = path.split('/').map(encodeURIComponent).join('/')
      return { url: `${content}/art/v/${id}/${version}/~${token}/${encoded}`, expiresAt }
    },
    createWith,
    async create(input) {
      const { artifact } = await createWith(input, {
        actor: { by: 'web', agentId: null, sessionId: input.origin?.sessionId ?? null },
      })
      return artifact
    },
    async patch(id, patch: ArtifactPatch) {
      const row = need(id)
      if (patch.title !== undefined) {
        const title = patch.title.trim()
        if (title === '' || title.length > 200)
          throw invalid('title is required (at most 200 characters)', 'INVALID_TITLE')
        sqlite
          .query('UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ?')
          .run(title, options.now(), id)
        event(id, 'rename', 'web', { from: row.title, to: title })
      }
      if (patch.description !== undefined) {
        sqlite
          .query('UPDATE artifacts SET description = ?, updated_at = ? WHERE id = ?')
          .run(patch.description.trim().slice(0, 2000), options.now(), id)
      }
      if (patch.visibility !== undefined || patch.shareVersion !== undefined) {
        const visibility = patch.visibility ?? row.visibility
        if (
          visibility === 'private' &&
          patch.shareVersion !== undefined &&
          patch.shareVersion !== null
        ) {
          throw invalid('a version can only be pinned on a public artifact', 'NOT_PUBLIC')
        }
        setVisibility(
          id,
          visibility,
          'web',
          patch.shareVersion === undefined ? {} : { shareVersion: patch.shareVersion },
        )
      }
      return viewOf(need(id))
    },
    async saveEntry(id, text, ifVersion) {
      const row = need(id)
      const bytes = encoder.encode(text).byteLength
      if (bytes > ARTIFACT_LIMITS.maxFileBytes)
        throw invalid(`text is larger than ${ARTIFACT_LIMITS.maxFileBytes} bytes`, 'FILE_TOO_LARGE')
      const path = `${row.dir}/${row.entry}`
      const result = await fsOf(null).write(
        path,
        text,
        ifVersion === undefined ? {} : { ifVersion },
      )
      if (!result.ok) {
        const details =
          result.currentVersion === undefined
            ? undefined
            : { currentVersion: result.currentVersion }
        throw conflict(
          `${path} was changed since the version you edited (an agent may have written it); reload and retry`,
          result.reason === 'exists' ? 'FILE_EXISTS' : 'VERSION_CONFLICT',
          details,
        )
      }
      dirty.delete(id)
      await snapshot(id, 'web', 'edited in the app')
      return viewOf(need(id))
    },
    exportOf,
    remove(id) {
      need(id)
      sqlite
        .query(
          "UPDATE artifacts SET deleted_at = ?, visibility = 'private', share_token = NULL, share_version = NULL WHERE id = ?",
        )
        .run(options.now(), id)
      dirty.delete(id)
      event(id, 'delete', 'web', {})
    },
    share(token) {
      const row = sqlite
        .query<ArtifactRow, [string]>(
          "SELECT * FROM artifacts WHERE share_token = ? AND visibility = 'public' AND deleted_at IS NULL",
        )
        .get(token)
      if (row === null) return undefined
      const version = row.share_version ?? row.version
      const v = versionRow(row.id, version)
      if (v === undefined) return undefined
      const base = `${content}/art/s/${token}/`
      const summary: ArtifactSummary = {
        ...summaryOf(row),
        version,
        entry: v.entry,
        // the share page needs no folder, agent or session
        dir: '',
        agentId: null,
        sessionId: null,
      }
      return {
        artifact: summary,
        entryUrl: `${base}${v.entry.split('/').map(encodeURIComponent).join('/')}`,
        baseUrl: base,
        files: filesOfVersion(v),
      } satisfies ArtifactShare
    },
    async libraryViewUrl(path): Promise<SignedUrl> {
      const expiresAt = options.now() + ARTIFACT_LIMITS.viewUrlTtlMs
      const token = await signer.sign(`l|${path}`, expiresAt)
      return {
        url: `${content}/art/l/${token}${path.split('/').map(encodeURIComponent).join('/')}`,
        expiresAt,
      }
    },
    onLibraryChange(change) {
      const paths = [change.path, ...(change.to === undefined ? [] : [change.to])]
      const found = sqlite
        .query<{ id: string; dir: string }, []>(
          'SELECT id, dir FROM artifacts WHERE deleted_at IS NULL',
        )
        .all()
      for (const a of found) {
        if (paths.some((p) => p.startsWith(`${a.dir}/`))) {
          dirty.set(a.id, { agentId: change.agentId })
          // a person's edit (the Files page) has no turn to end: snapshot it shortly after
          if (change.agentId === null) {
            const timer = setTimeout(() => {
              if (dirty.get(a.id)?.agentId === null) {
                dirty.delete(a.id)
                void snapshot(a.id, 'web', 'edited in the app').catch(() => undefined)
              }
            }, 1500)
            timer.unref?.()
          }
        }
      }
    },
    async snapshotDirty(agentId) {
      const out: Array<{ id: string; title: string; n: number | null; problems: string[] }> = []
      for (const [id, d] of [...dirty]) {
        if (d.agentId !== agentId) continue
        dirty.delete(id)
        const row = rowOf(id)
        if (row === undefined) continue
        const r = await snapshot(id, agentId === null ? 'web' : `agent:${agentId}`, 'updated')
        out.push({ id, title: row.title, n: r.n, problems: r.problems })
      }
      return out
    },
    snapshot,
    setVisibility,
    appUrl: (id) => `${web}/artifacts/${id}`,
    contentOfVersion,
    contentOfShare,
    verifyView: (id, version, token) => signer.verify(`v|${id}|${version}`, token, options.now()),
    verifyLibrary: (path, token) => signer.verify(`l|${path}`, token, options.now()),
    async contentOfLibrary(path) {
      if (!path.startsWith('/') || path.startsWith('/memories')) return undefined
      const read = await fsOf(null).readBytes?.(path)
      if (read === undefined || read === null) return undefined
      return { bytes: read.bytes, mediaType: mediaTypeOf(path) }
    },
    event,
  }
  return service
}
