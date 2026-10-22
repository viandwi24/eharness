/**
 * The workspace export: one zip a person can open and read (`.md` and `.json` in folders), and the
 * import that reads it back. Pure rules: the folder layout, the path checks (zip-slip), the manifest
 * shape, the sections an import is split in, and the readable diffs of its preview. Reading and
 * writing the zip is `infra/backup`; collecting and applying entities is `app/workspace-export.ts`
 * and `app/workspace-import.ts`.
 *
 * Layout:
 *
 *   manifest.json                          format, versions, counts, sha256 of every other file
 *   settings.json                          workspace settings and the digest (no secrets)
 *   library/**, uploads/**, other/**       every library file as it is (`other/` = any other root)
 *   memory/**                              workspace memory (`/memories/workspace/...`)
 *   agents/<slug>/agent.json               the definition: model, authority, connector enablement
 *   agents/<slug>/persona.md               identity, voice and operating rules
 *   agents/<slug>/heartbeat.json           the heartbeat configuration
 *   agents/<slug>/memory/**                the agent's memory files (HEARTBEAT.md with its standing orders)
 *   agents/<slug>/programs/<name>.json     a program (its brief is `<name>.brief.md`)
 *   agents/<slug>/routines/<id>.json       a routine
 *   agents/<slug>/reminders/<id>.json      an active reminder (a reference: never imported)
 *   connections/<label>.json               a connection WITHOUT secrets (a reference: never imported)
 *   people/<id>.json                       a person of the directory
 *   secrets.enc.json                       OPTIONAL: provider keys and connection credentials, encrypted with
 *                                          the passphrase chosen at export (`workspace-secrets.ts`)
 *
 * Chats, task transcripts and logs are not in it: the verified database snapshot covers full
 * disaster recovery.
 */
import { invalid } from './errors.ts'
import { SECRETS_FILE } from './workspace-secrets.ts'

export const WORKSPACE_FORMAT = 'eharness-team-workspace'
export const WORKSPACE_FORMAT_VERSION = 1

const MIB = 1024 * 1024
/** What an import accepts: a larger or more crowded zip is refused before anything is read. */
export const IMPORT_LIMITS = {
  zipBytes: 128 * MIB,
  entries: 20_000,
  entryBytes: 64 * MIB,
  totalBytes: 256 * MIB,
} as const

/** A cache of tool results, pruned in days: not part of the export. */
export const TOOL_MEDIA_PREFIX = '/.eharness/tool-media'

/** A file the app hands the export writer (an entity document; library files are streamed by infra). */
export interface EntityFile {
  path: string
  bytes: Uint8Array
}

/** Where an import reads from: a stored backup, or a zip uploaded for this import. */
export type ImportSource = { backupId: string } | { uploadId: string }

/** An active reminder as the export lists it (a reference: reminders are tied to chats). */
export interface ReminderRecord {
  id: string
  agentId: string
  connectionId: string
  nodeId: string
  body: string
  mentions: string[]
  schedule: unknown
  whenText: string
  timezone: string
  createdAt: number
  fireCount: number
}

// --- sections ----------------------------------------------------------------------------------

export const SECTIONS = [
  'settings',
  'agents',
  'programs',
  'routines',
  'memory',
  'library',
  'people',
  'connections',
  'reminders',
  'secrets',
] as const
export type SectionId = (typeof SECTIONS)[number]

export const SECTION_LABELS: Record<SectionId, string> = {
  settings: 'Workspace settings',
  agents: 'Agents (definition, persona, heartbeat)',
  programs: 'Programs',
  routines: 'Routines',
  memory: 'Memory files',
  library: 'Library files',
  people: 'People',
  connections: 'Connections (reference only)',
  reminders: 'Reminders (reference only)',
  secrets: 'Secrets (encrypted in the zip)',
}

/** Sections that are listed for reading and never written (a connection's secrets come back through the secrets section). */
export const REFERENCE_SECTIONS: readonly SectionId[] = ['connections', 'reminders']

export const isSection = (value: string): value is SectionId =>
  (SECTIONS as readonly string[]).includes(value)

// --- paths -------------------------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const PROGRAM_FILE = /^[a-z0-9][a-z0-9-]{0,79}(\.brief\.md|\.json)$/
const ID_FILE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\.json$/
const LABEL_FILE = /^[a-z0-9][a-z0-9-]{0,79}\.json$/

export type EntryKind =
  | 'manifest'
  | 'settings'
  | 'agent'
  | 'persona'
  | 'heartbeat'
  | 'program'
  | 'program-brief'
  | 'routine'
  | 'reminder'
  | 'connection'
  | 'person'
  | 'secrets'
  | 'file'

export interface Classified {
  section: SectionId | null
  kind: EntryKind
  /** The agent slug of `agents/<slug>/...`. */
  agent?: string
}

const rest = (parts: string[], from: number): string => parts.slice(from).join('/')

/** What an entry is, or undefined for a path the format does not know (refused on import). */
export function classify(entry: string): Classified | undefined {
  const parts = entry.split('/')
  const top = parts[0]
  if (parts.length === 1) {
    if (entry === 'manifest.json') return { section: null, kind: 'manifest' }
    if (entry === 'settings.json') return { section: 'settings', kind: 'settings' }
    if (entry === SECRETS_FILE) return { section: 'secrets', kind: 'secrets' }
    return undefined
  }
  if (top === 'library' || top === 'uploads' || top === 'other') {
    return { section: 'library', kind: 'file' }
  }
  if (top === 'memory') return { section: 'memory', kind: 'file' }
  if (top === 'connections') {
    return parts.length === 2 && LABEL_FILE.test(parts[1] ?? '')
      ? { section: 'connections', kind: 'connection' }
      : undefined
  }
  if (top === 'people') {
    return parts.length === 2 && ID_FILE.test(parts[1] ?? '')
      ? { section: 'people', kind: 'person' }
      : undefined
  }
  if (top === 'agents') {
    const slug = parts[1] ?? ''
    if (!SLUG.test(slug) || parts.length < 3) return undefined
    const agent = slug
    const name = parts[2] ?? ''
    if (parts.length === 3) {
      if (name === 'agent.json') return { section: 'agents', kind: 'agent', agent }
      if (name === 'persona.md') return { section: 'agents', kind: 'persona', agent }
      if (name === 'heartbeat.json') return { section: 'agents', kind: 'heartbeat', agent }
      return undefined
    }
    if (name === 'memory') return { section: 'memory', kind: 'file', agent }
    if (parts.length === 4 && name === 'programs' && PROGRAM_FILE.test(parts[3] ?? '')) {
      return {
        section: 'programs',
        kind: (parts[3] ?? '').endsWith('.brief.md') ? 'program-brief' : 'program',
        agent,
      }
    }
    if (parts.length === 4 && name === 'routines' && ID_FILE.test(parts[3] ?? '')) {
      return { section: 'routines', kind: 'routine', agent }
    }
    if (parts.length === 4 && name === 'reminders' && ID_FILE.test(parts[3] ?? '')) {
      return { section: 'reminders', kind: 'reminder', agent }
    }
  }
  return undefined
}

/**
 * Why a zip entry name is refused, or undefined. Absolute paths, `..`, backslashes, control
 * characters and anything outside the folders above are refused (zip-slip).
 */
export function checkZipPath(name: string): string | undefined {
  if (name === '' || name.length > 700) return 'an entry name is empty or too long'
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return `absolute path: ${name}`
  if (name.includes('\\')) return `backslash in the path: ${name}`
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character in an entry name'
  const parts = name.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return `path escapes the folder: ${name}`
  }
  if (classify(name) === undefined) return `unexpected path: ${name}`
  return undefined
}

/** The zip entry of a library or memory file (`/memories/agents/<id>/x` is named by the agent slug). */
export function entryOfFile(path: string, slugById: ReadonlyMap<string, string>): string {
  const parts = path.replace(/^\/+/, '').split('/')
  if (parts[0] === 'memories') {
    if (parts[1] === 'workspace' && parts.length > 2) return `memory/${rest(parts, 2)}`
    if (parts[1] === 'agents' && parts[2] !== undefined && parts.length > 3) {
      const slug = slugById.get(parts[2])
      if (slug !== undefined) return `agents/${slug}/memory/${rest(parts, 3)}`
    }
    return `other/${parts.join('/')}`
  }
  if (parts[0] === 'library' || parts[0] === 'uploads') return parts.join('/')
  return `other/${parts.join('/')}`
}

/**
 * The library path of an entry: undefined for a memory entry of an agent that is not known yet.
 * `idBySlug` maps agent slugs to their ids in the workspace the import writes to.
 */
export function fileOfEntry(
  entry: string,
  idBySlug: ReadonlyMap<string, string>,
): string | undefined {
  const parts = entry.split('/')
  if (parts[0] === 'memory') return `/memories/workspace/${rest(parts, 1)}`
  if (parts[0] === 'agents') {
    const id = idBySlug.get(parts[1] ?? '')
    return id === undefined ? undefined : `/memories/agents/${id}/${rest(parts, 3)}`
  }
  if (parts[0] === 'other') return `/${rest(parts, 1)}`
  return `/${parts.join('/')}`
}

/** A readable file name from a name: `Weekly report!` becomes `weekly-report`. */
export function slugOfName(name: string, fallback = 'item'): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug === '' ? fallback : slug
}

/** `base`, then `base-2`, `base-3`... the first name not in `taken` (which receives it). */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  taken.add(name)
  return name
}

// --- documents ---------------------------------------------------------------------------------

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

/** JSON with sorted keys and a trailing newline: the same data is always the same bytes. */
export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })
export const bytesOf = (text: string): Uint8Array => encoder.encode(text)
export const textOf = (bytes: Uint8Array): string => decoder.decode(bytes)

export interface ManifestFile {
  path: string
  size: number
  sha256: string
  /** Library files only: the stored media type and whether the file is binary (kept as bytes). */
  mediaType?: string | null
  binary?: boolean
}

export interface WorkspaceManifest {
  format: typeof WORKSPACE_FORMAT
  formatVersion: number
  app: { name: string; version: string }
  createdAt: number
  counts: Record<string, number>
  /** Every file of the zip except `manifest.json` itself. */
  files: ManifestFile[]
  /** What was left out on purpose (tool media). */
  excluded: Array<{ prefix: string; files: number }>
  /**
   * Whether `secrets.enc.json` is in the zip and how many secrets it holds (a count, never names or
   * values). Absent in the zips of earlier versions: no secrets.
   */
  secrets: { included: boolean; count: number }
  /** Said in the file so a reader of the zip knows: connections never carry secrets. */
  notice: string
}

export const MANIFEST_NOTICE =
  'Secrets are not exported: reconnect connections after an import. Chats, task transcripts and logs are not in this file; the database snapshot of the same backup keeps them.'

export const MANIFEST_NOTICE_WITH_SECRETS =
  'Secrets are in secrets.enc.json, encrypted (AES-256-GCM, key from a passphrase by PBKDF2-SHA256): they cannot be read without the passphrase of this export. Chats, task transcripts and logs are not in this file; the database snapshot of the same backup keeps them.'

function parseSecrets(value: unknown): WorkspaceManifest['secrets'] {
  const o = (value ?? {}) as Record<string, unknown>
  return o.included === true && typeof o.count === 'number' && Number.isInteger(o.count)
    ? { included: true, count: o.count }
    : { included: false, count: 0 }
}

/** The manifest of a zip, checked for shape; anything else is refused with a readable reason. */
export function parseManifest(value: unknown): WorkspaceManifest {
  const fail = (why: string): never => {
    throw invalid(`This is not a workspace export: ${why}`, 'IMPORT_REFUSED')
  }
  if (value === null || typeof value !== 'object') return fail('manifest.json is not an object')
  const m = value as Record<string, unknown>
  if (m.format !== WORKSPACE_FORMAT) {
    return fail(
      'manifest.json has no format marker (an older backup zip lists files only; take a new backup)',
    )
  }
  if (typeof m.formatVersion !== 'number' || !Number.isInteger(m.formatVersion)) {
    return fail('the format version is missing')
  }
  if (m.formatVersion > WORKSPACE_FORMAT_VERSION) {
    return fail(
      `the format version ${m.formatVersion} is newer than this server reads (${WORKSPACE_FORMAT_VERSION})`,
    )
  }
  if (!Array.isArray(m.files)) return fail('the file list is missing')
  const files: ManifestFile[] = []
  for (const f of m.files as unknown[]) {
    const o = (f ?? {}) as Record<string, unknown>
    if (
      typeof o.path !== 'string' ||
      typeof o.size !== 'number' ||
      typeof o.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(o.sha256)
    ) {
      return fail('a file entry of the manifest is malformed')
    }
    files.push({
      path: o.path,
      size: o.size,
      sha256: o.sha256,
      ...(typeof o.mediaType === 'string' || o.mediaType === null
        ? { mediaType: o.mediaType }
        : {}),
      ...(typeof o.binary === 'boolean' ? { binary: o.binary } : {}),
    })
  }
  const app = (m.app ?? {}) as Record<string, unknown>
  return {
    format: WORKSPACE_FORMAT,
    formatVersion: m.formatVersion,
    app: {
      name: typeof app.name === 'string' ? app.name : 'unknown',
      version: typeof app.version === 'string' ? app.version : 'unknown',
    },
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
    counts:
      m.counts !== null && typeof m.counts === 'object' ? (m.counts as Record<string, number>) : {},
    files,
    excluded: Array.isArray(m.excluded) ? (m.excluded as WorkspaceManifest['excluded']) : [],
    secrets: parseSecrets(m.secrets),
    notice: typeof m.notice === 'string' ? m.notice : MANIFEST_NOTICE,
  }
}

// --- readable diffs ----------------------------------------------------------------------------

export const DIFF_MAX_LINES = 120
const DIFF_MAX_INPUT_LINES = 1500
const DIFF_MAX_BYTES = 400_000

/**
 * A readable line diff (`- removed`, `+ added`, one line of context, `...` between hunks), or a
 * short note when the text is too long to compare. Empty when the texts are equal.
 */
export function lineDiff(before: string, after: string): string {
  if (before === after) return ''
  if (before.length + after.length > DIFF_MAX_BYTES) {
    return `(the text is too long to compare line by line: ${before.length} -> ${after.length} characters)`
  }
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > DIFF_MAX_INPUT_LINES || b.length > DIFF_MAX_INPUT_LINES) {
    return `(the text is too long to compare line by line: ${a.length} -> ${b.length} lines)`
  }
  // longest common subsequence table
  const w = b.length + 1
  const t = new Uint16Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i * w + j] =
        a[i] === b[j]
          ? (t[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0)
    }
  }
  const ops: Array<{ op: ' ' | '-' | '+'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i] as string })
      i++
      j++
    } else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) {
      ops.push({ op: '-', text: a[i++] as string })
    } else {
      ops.push({ op: '+', text: b[j++] as string })
    }
  }
  while (i < a.length) ops.push({ op: '-', text: a[i++] as string })
  while (j < b.length) ops.push({ op: '+', text: b[j++] as string })
  // keep changed lines with one line of context on each side
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((o, k) => {
    if (o.op === ' ') return
    for (const n of [k - 1, k, k + 1]) if (n >= 0 && n < ops.length) keep[n] = true
  })
  const out: string[] = []
  let gap = false
  ops.forEach((o, k) => {
    if (!keep[k]) {
      gap = true
      return
    }
    if (gap && out.length > 0) out.push('...')
    gap = false
    out.push(`${o.op} ${o.text}`)
  })
  if (out.length > DIFF_MAX_LINES) {
    const more = out.length - DIFF_MAX_LINES
    return `${out.slice(0, DIFF_MAX_LINES).join('\n')}\n... ${more} more lines`
  }
  return out.join('\n')
}

export interface FieldChange {
  field: string
  before: string
  after: string
}

const shown = (v: unknown): string => {
  if (v === undefined) return '(none)'
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Changed fields of two JSON values, by dotted path (arrays and scalars are compared whole). */
export function jsonFieldDiff(before: unknown, after: unknown, base = ''): FieldChange[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    return keys.flatMap((k) => jsonFieldDiff(before[k], after[k], base === '' ? k : `${base}.${k}`))
  }
  if (canonicalJson(before) === canonicalJson(after)) return []
  return [{ field: base === '' ? '(value)' : base, before: shown(before), after: shown(after) }]
}

// --- the plan of an import ---------------------------------------------------------------------

/** `added` not here yet, `changed` differs, `unchanged` equal, `only-live` here and not in the zip. */
export type ItemStatus = 'added' | 'changed' | 'unchanged' | 'only-live'

export interface ImportItem {
  /** The entry path in the zip (for `only-live`: the entry path it would have). */
  key: string
  section: SectionId
  kind: EntryKind
  /** A readable name: an agent's name, a file path. */
  label: string
  status: ItemStatus
  /** False for the reference sections and for an item that cannot be applied (see `blocked`). */
  applicable: boolean
  /** Why it cannot be applied (the lead exists, the agent is unknown, ...). */
  blocked: string | null
  /** Changed fields of a JSON entity. */
  fields: FieldChange[]
  /** A line diff of a text entry. */
  diff: string | null
  /** What applying it would grant: permission mode, tool rules, connector enablement, roles. */
  authority: string[]
  /** Things to know before applying (a connection that is not here, a model profile that is not here). */
  notes: string[]
  sizeBefore: number | null
  sizeAfter: number | null
}

export interface SectionSummary {
  id: SectionId
  label: string
  added: number
  changed: number
  unchanged: number
  onlyLive: number
  /** The section can be applied (false: reference only). */
  applicable: boolean
}

export interface ImportSelection {
  /** Sections to apply. */
  sections: SectionId[]
  /** Entry keys of single items that are unticked. */
  exclude: string[]
  /** Sections where the items only in the workspace are removed too (agents are archived). */
  removeSections: SectionId[]
  /**
   * Replace items that exist here and differ. False (the default): they are skipped, only new items
   * are added. An undo always overwrites (it puts back exactly what the import changed).
   */
  overwrite: boolean
}

export const PREVIEW_ITEM_MAX = 2000

/** What a preview answers: counts per section for everything, and the items that are not equal. */
export interface ImportPreview {
  source: { kind: 'backup' | 'upload'; id: string }
  manifest: {
    createdAt: number
    appVersion: string
    formatVersion: number
    counts: Record<string, number>
  }
  sections: SectionSummary[]
  /** The zip's secrets: whether there are any, how many, and whether the passphrase opened them. */
  secrets: { included: boolean; count: number; unlocked: boolean }
  /** Changes first; at most `PREVIEW_ITEM_MAX`. */
  items: ImportItem[]
  truncated: boolean
  warnings: string[]
}

/** Counts of a preview, section by section, in the order of {@link SECTIONS}. */
export function summarize(items: readonly ImportItem[]): SectionSummary[] {
  return SECTIONS.map((id) => {
    const own = items.filter((i) => i.section === id)
    const count = (s: ItemStatus): number => own.filter((i) => i.status === s).length
    return {
      id,
      label: SECTION_LABELS[id],
      added: count('added'),
      changed: count('changed'),
      unchanged: count('unchanged'),
      onlyLive: count('only-live'),
      applicable: !REFERENCE_SECTIONS.includes(id),
    }
  })
}

/** Whether the selection applies an item: ticked section, not excluded, applicable, a change. */
export function selects(item: ImportItem, selection: ImportSelection): boolean {
  if (!item.applicable || item.status === 'unchanged') return false
  if (!selection.sections.includes(item.section)) return false
  if (selection.exclude.includes(item.key)) return false
  if (item.status === 'only-live') return selection.removeSections.includes(item.section)
  // an item that exists here and differs is skipped unless the owner chose to overwrite
  if (item.status === 'changed' && !selection.overwrite) return false
  return true
}

/** Sections that need more than a tick: secrets also need the passphrase. */
export const GATED_SECTIONS: readonly SectionId[] = ['secrets']

/** A selection of every applicable section (secrets only when asked for), nothing excluded, nothing removed, no overwrite. */
export const defaultSelection = (): ImportSelection => ({
  sections: SECTIONS.filter((s) => !REFERENCE_SECTIONS.includes(s) && !GATED_SECTIONS.includes(s)),
  exclude: [],
  removeSections: [],
  overwrite: false,
})
