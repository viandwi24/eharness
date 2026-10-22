/**
 * The data tables of the workspace export: what the zip carries as plain rows (`data/<table>/NNN.json`)
 * next to the readable entity documents. Pure rules: the sections, the dataset of every table (which
 * columns identify a row, what is left out), the file format, the identity of a row, and the
 * remapping of ids when an import lands in a workspace whose entities got other ids (the seeded
 * agents, an agent created by the import).
 *
 * A dataset is applied row by row under one policy: a row that is not here yet is added; a row that
 * is here and differs is replaced only when the owner chose to overwrite; nothing is deleted unless
 * the section is ticked for removal. The importing code never runs a model or a tool: it writes rows.
 */
import { invalid } from './errors.ts'

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
  'channels',
  'history',
  'artifacts',
  'api',
  'browser',
  'conversations',
  'secrets',
] as const
export type SectionId = (typeof SECTIONS)[number]

// --- datasets ----------------------------------------------------------------------------------

/** A row as the zip carries it: JSON-safe values; a BLOB is `{ "$b64": "..." }`. */
export type DataRow = Record<string, unknown>

export interface DatasetSpec {
  table: string
  section: SectionId
  /** The columns that identify a row (the primary key, or a unique key the app relies on). */
  key: readonly string[]
  /** The key is unique by construction of the app, not by an index of the database. */
  logicalKey?: boolean
  /** SQL `WHERE` of the rows the export carries (default: all). */
  where?: string
  /** SQL `ORDER BY` of the export; also the order rows are written in. */
  order: string
  /** Columns that are neither exported nor written (leases and claims of a running instance). */
  skip?: readonly string[]
  /** Columns exported as null: their value travels in the encrypted secrets file. */
  strip?: readonly string[]
  /** BLOB columns. */
  blobs?: readonly string[]
  /**
   * An AUTOINCREMENT column: not exported, assigned on insert; a row is identified by all its
   * other columns.
   */
  seq?: string
  /** Columns of a readable name of a row, for the preview. */
  label: readonly string[]
}

const spec = (s: DatasetSpec): DatasetSpec => s

/** Every dataset of the export, in the order they are applied. */
export const DATASETS: readonly DatasetSpec[] = [
  // settings: the key-value rows other than the ones the entity documents carry
  spec({
    table: 'settings',
    section: 'settings',
    key: ['key'],
    where:
      "key NOT IN ('workspace', 'digest:config', 'events-pruned-through') AND key NOT LIKE 'heartbeat:%:config'",
    order: 'key',
    label: ['key'],
  }),
  // agents
  spec({
    table: 'agent_persona_versions',
    section: 'agents',
    key: ['agent_id', 'version'],
    order: 'agent_id, version',
    label: ['agent_id', 'version'],
  }),
  spec({
    table: 'agent_persona_proposals',
    section: 'agents',
    key: ['id'],
    order: 'created_at, id',
    label: ['id'],
  }),
  // programs
  spec({
    table: 'program_tests',
    section: 'programs',
    key: ['id'],
    order: 'created_at, id',
    label: ['name'],
  }),
  spec({
    table: 'rehearsals',
    section: 'programs',
    key: ['id'],
    order: 'started_at, id',
    label: ['id'],
  }),
  // people
  spec({
    table: 'people_accounts',
    section: 'people',
    key: ['id'],
    order: 'linked_at, id',
    label: ['platform', 'native_id'],
  }),
  spec({
    table: 'people_events',
    section: 'people',
    key: ['id'],
    order: 'at, id',
    label: ['kind', 'at'],
  }),
  // reminders: the reminder rows and the schedule rows that fire them
  spec({
    table: 'ch_reminders',
    section: 'reminders',
    key: ['id'],
    order: 'created_at, id',
    label: ['body'],
  }),
  spec({
    table: 'routines',
    section: 'reminders',
    key: ['program_id'],
    logicalKey: true,
    where: "program_id LIKE 'sys:reminder:%'",
    order: 'created_at, id',
    skip: ['claimed_by', 'claimed_until'],
    label: ['program_id'],
  }),
  // channels: configuration, never the message log
  spec({
    table: 'channel_connections',
    section: 'channels',
    key: ['connection_id'],
    order: 'connection_id',
    label: ['connection_id'],
  }),
  spec({
    table: 'tgu_settings',
    section: 'channels',
    key: ['connection_id'],
    order: 'connection_id',
    label: ['connection_id'],
  }),
  spec({
    table: 'tgu_chats',
    section: 'channels',
    key: ['connection_id', 'chat_id'],
    order: 'connection_id, chat_id',
    label: ['title'],
  }),
  spec({
    table: 'ch_nodes',
    section: 'channels',
    key: ['connection_id', 'native_id'],
    order: 'connection_id, path, id',
    label: ['title', 'native_id'],
  }),
  spec({
    table: 'ch_node_links',
    section: 'channels',
    key: ['from_node_id', 'to_node_id', 'rel'],
    order: 'from_node_id, to_node_id, rel',
    label: ['rel'],
  }),
  spec({
    table: 'ch_node_access',
    section: 'channels',
    key: ['node_id'],
    order: 'node_id',
    label: ['node_id'],
  }),
  spec({
    table: 'ch_node_settings',
    section: 'channels',
    key: ['node_id', 'key'],
    order: 'node_id, key',
    label: ['key'],
  }),
  spec({
    table: 'ch_identities',
    section: 'channels',
    key: ['connection_id', 'native_id'],
    order: 'connection_id, native_id',
    label: ['display_name', 'native_id'],
  }),
  spec({
    table: 'ch_identity_aliases',
    section: 'channels',
    key: ['identity_id', 'kind', 'value'],
    order: 'identity_id, kind, value',
    label: ['kind', 'value'],
  }),
  spec({
    table: 'ch_identity_profiles',
    section: 'channels',
    key: ['identity_id', 'scope_node_id'],
    order: 'identity_id, scope_node_id',
    label: ['nick'],
  }),
  spec({
    table: 'ch_memberships',
    section: 'channels',
    key: ['node_id', 'identity_id'],
    order: 'node_id, identity_id',
    label: ['role'],
  }),
  spec({
    table: 'ch_node_sessions',
    section: 'channels',
    key: ['connection_id', 'node_id'],
    order: 'connection_id, node_id',
    label: ['label', 'session_id'],
  }),
  spec({
    table: 'ch_people',
    section: 'channels',
    key: ['identity_id'],
    order: 'identity_id',
    label: ['role'],
  }),
  spec({
    table: 'ch_people_notes',
    section: 'channels',
    key: ['identity_id'],
    order: 'identity_id',
    label: ['identity_id'],
  }),
  spec({
    table: 'ch_proactive',
    section: 'channels',
    key: ['id'],
    order: 'created_at, id',
    label: ['body'],
  }),
  // history: what happened, as metadata
  spec({
    table: 'tasks',
    section: 'history',
    key: ['id'],
    order: 'started_at, id',
    label: ['title'],
  }),
  spec({
    table: 'decisions',
    section: 'history',
    key: ['id'],
    order: 'created_at, id',
    label: ['title'],
  }),
  spec({
    table: 'alarms',
    section: 'history',
    key: ['id'],
    order: 'created_at, id',
    label: ['text'],
  }),
  spec({
    table: 'notifications',
    section: 'history',
    key: ['id'],
    order: 'created_at, id',
    label: ['title'],
  }),
  spec({
    table: 'briefings',
    section: 'history',
    key: ['day'],
    order: 'day',
    label: ['day', 'title'],
  }),
  // artifacts: the share token travels in the encrypted secrets file
  spec({
    table: 'artifacts',
    section: 'artifacts',
    key: ['id'],
    order: 'created_at, id',
    strip: ['share_token'],
    label: ['title'],
  }),
  spec({
    table: 'artifact_versions',
    section: 'artifacts',
    key: ['artifact_id', 'n'],
    order: 'artifact_id, n',
    label: ['artifact_id', 'n'],
  }),
  spec({
    table: 'artifact_blobs',
    section: 'artifacts',
    key: ['hash'],
    order: 'hash',
    blobs: ['bytes'],
    label: ['hash'],
  }),
  spec({
    table: 'artifact_events',
    section: 'artifacts',
    key: [],
    seq: 'seq',
    order: 'seq',
    label: ['action', 'artifact_id'],
  }),
  // the developer API: its keys travel in the encrypted secrets file (only their hash)
  spec({
    table: 'api_agents',
    section: 'api',
    key: ['id'],
    order: 'created_at, id',
    label: ['name'],
  }),
  spec({
    table: 'api_requests',
    section: 'api',
    key: ['id'],
    order: 'at, id',
    label: ['id'],
  }),
  spec({
    table: 'api_calls',
    section: 'api',
    key: ['id'],
    order: 'at, id',
    label: ['id'],
  }),
  // browser
  spec({
    table: 'browser_profiles',
    section: 'browser',
    key: ['id'],
    order: 'created_at, id',
    label: ['name'],
  }),
  // conversations (opt-in: large)
  spec({
    table: 'chats',
    section: 'conversations',
    key: ['agent_id'],
    order: 'agent_id',
    label: ['agent_id'],
  }),
  spec({
    table: 'chat_threads',
    section: 'conversations',
    key: ['session_id'],
    order: 'created_at, id',
    label: ['title', 'session_id'],
  }),
  spec({
    table: 'session_modes',
    section: 'conversations',
    key: ['session_id'],
    order: 'session_id',
    label: ['session_id'],
  }),
  spec({
    table: 'chat_tool_overrides',
    section: 'conversations',
    key: ['session_id'],
    order: 'session_id',
    label: ['session_id'],
  }),
  spec({
    table: 'eh_state',
    section: 'conversations',
    key: ['session_id'],
    order: 'session_id',
    label: ['session_id'],
  }),
  spec({
    table: 'eh_messages',
    section: 'conversations',
    key: ['session_id', 'id'],
    order: 'session_id, id',
    label: ['session_id', 'id'],
  }),
  spec({
    table: 'api_conversations',
    section: 'conversations',
    key: ['id'],
    order: 'created_at, id',
    label: ['id'],
  }),
]

export const DATASET_BY_TABLE: ReadonlyMap<string, DatasetSpec> = new Map(
  DATASETS.map((d) => [d.table, d]),
)

/** The datasets of a section, in apply order. */
export const datasetsOf = (section: SectionId): DatasetSpec[] =>
  DATASETS.filter((d) => d.section === section)

// --- the file format ---------------------------------------------------------------------------

export const ROWS_FORMAT = 'eharness-team-rows'
const MIB = 1024 * 1024
/** A part of a dataset holds at most this many rows or about this many bytes of JSON. */
export const PART_MAX_ROWS = 2000
export const PART_MAX_BYTES = 6 * MIB

export const dataEntry = (table: string, part: number): string =>
  `data/${table}/${String(part).padStart(3, '0')}.json`

const PART_FILE = /^\d{3,6}\.json$/

/** The dataset a zip path belongs to (`data/<table>/NNN.json`), or undefined. */
export function datasetOfEntry(entry: string): DatasetSpec | undefined {
  const parts = entry.split('/')
  if (parts.length !== 3 || parts[0] !== 'data' || !PART_FILE.test(parts[2] ?? '')) return undefined
  return DATASET_BY_TABLE.get(parts[1] ?? '')
}

export interface RowsFile {
  format: typeof ROWS_FORMAT
  table: string
  part: number
  rows: DataRow[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A parsed part of a dataset; anything that is not in the format is refused with a reason. */
export function parseRowsFile(text: string, spec: DatasetSpec): RowsFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw invalid(`${spec.table}: the data file is not valid JSON`, 'IMPORT_REFUSED')
  }
  if (
    !isObject(raw) ||
    raw.format !== ROWS_FORMAT ||
    raw.table !== spec.table ||
    !Array.isArray(raw.rows) ||
    !raw.rows.every(isObject)
  ) {
    throw invalid(
      `${spec.table}: the data file is not in the format of the export`,
      'IMPORT_REFUSED',
    )
  }
  return {
    format: ROWS_FORMAT,
    table: spec.table,
    part: typeof raw.part === 'number' ? raw.part : 0,
    rows: raw.rows as DataRow[],
  }
}

/** Splits rows into parts by count and size. An empty table is one part with no rows. */
export function chunkRows(rows: readonly DataRow[]): DataRow[][] {
  const parts: DataRow[][] = []
  let current: DataRow[] = []
  let bytes = 0
  for (const row of rows) {
    const size = JSON.stringify(row).length
    if (current.length > 0 && (current.length >= PART_MAX_ROWS || bytes + size > PART_MAX_BYTES)) {
      parts.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  parts.push(current)
  return parts
}

// --- identity and comparison -------------------------------------------------------------------

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

/** A row as one comparable string (sorted keys). */
export const rowFingerprint = (row: DataRow): string => JSON.stringify(sortKeys(row))

/** The columns of a row that identify it (all of them but the sequence for an append-only table). */
export function rowKey(spec: DatasetSpec, row: DataRow): string {
  if (spec.seq !== undefined) {
    const { [spec.seq]: _seq, ...rest } = row
    return rowFingerprint(rest)
  }
  return JSON.stringify(spec.key.map((k) => row[k] ?? null))
}

/** A readable name of a row for the preview. */
export function rowLabel(spec: DatasetSpec, row: DataRow): string {
  const text = spec.label
    .map((c) => row[c])
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => String(v).replace(/\s+/g, ' ').slice(0, 80))
    .join(' ')
  return text === '' ? rowKey(spec, row).slice(0, 80) : text
}

export interface RowComparison {
  added: DataRow[]
  changed: Array<{ before: DataRow; after: DataRow }>
  same: number
  /** Rows only in the workspace (kept unless the section is ticked for removal). */
  onlyLive: DataRow[]
}

/** Compare the rows of a zip with the live rows of the same table. */
export function compareRows(
  spec: DatasetSpec,
  zip: readonly DataRow[],
  live: readonly DataRow[],
): RowComparison {
  const liveByKey = new Map(live.map((r) => [rowKey(spec, r), r] as const))
  const seen = new Set<string>()
  const out: RowComparison = { added: [], changed: [], same: 0, onlyLive: [] }
  for (const row of zip) {
    const k = rowKey(spec, row)
    seen.add(k)
    const found = liveByKey.get(k)
    if (found === undefined) out.added.push(row)
    else if (rowFingerprint(found) === rowFingerprint(row)) out.same++
    else out.changed.push({ before: found, after: row })
  }
  for (const [k, row] of liveByKey) if (!seen.has(k)) out.onlyLive.push(row)
  return out
}

// --- remapping ids -----------------------------------------------------------------------------

/**
 * Old id -> id in this workspace. An import creates entities under new ids (and the seeded agents
 * have their own), while the rows of the zip name the old ones: every text value of a row is
 * rewritten (ids are 36-character UUIDs, so nothing else can match), which also fixes ids embedded in
 * session ids (`dm:<agent>`), settings keys (`heartbeat:<agent>:state`) and JSON text.
 */
export class IdMap {
  private pairs = new Map<string, string>()
  private pattern: RegExp | undefined

  /** Records that `from` is `to` here (nothing when they are the same). */
  set(from: string, to: string): void {
    if (from === to || from === '') return
    if (this.pairs.get(from) === to) return
    this.pairs.set(from, to)
    this.pattern = undefined
  }

  get size(): number {
    return this.pairs.size
  }

  get(from: string): string {
    return this.pairs.get(from) ?? from
  }

  entries(): Array<[string, string]> {
    return [...this.pairs]
  }

  text(value: string): string {
    if (this.pairs.size === 0 || value.length < 8) return value
    this.pattern ??= new RegExp(
      [...this.pairs.keys()]
        .sort((a, b) => b.length - a.length)
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'g',
    )
    this.pattern.lastIndex = 0
    return value.replace(this.pattern, (m) => this.pairs.get(m) ?? m)
  }

  row(row: DataRow): DataRow {
    if (this.pairs.size === 0) return row
    const out: DataRow = {}
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? this.text(v) : v
    return out
  }
}
