/**
 * Import of a workspace zip: parse and verify it (`infra/backup`), compare every entity with the
 * live workspace into a PREVIEW (added, changed with a readable diff, unchanged, only in the
 * workspace), and apply what the owner confirmed.
 *
 * Rules:
 *  - An import never deletes. Items only in the workspace are kept unless the owner ticked
 *    "remove what is not in the zip" for their section (agents are archived, files, programs,
 *    routines and people are deleted).
 *  - Everything is matched by a stable key and keeps the live ids: an agent by slug, a program by
 *    name per agent, a routine by id then name, a library or memory file by path, a person by id
 *    then name. New entities get new ids; references (the agent of a program, the memory folder of
 *    an agent, the connections of an enablement) are remapped.
 *  - An item that exists here and differs is SKIPPED unless the owner chose to overwrite ("Apply
 *    (skip existing)" adds new items only; "Apply and overwrite existing" replaces the changed ones
 *    too). An undo always overwrites: it puts back exactly what the import changed.
 *  - Secrets travel only in `secrets.enc.json`, encrypted with the passphrase of the export. The
 *    preview lists them (names, never values) once the passphrase opens the file; a wrong passphrase
 *    fails readably and nothing secret is imported. They are restored under the same policy.
 *  - What an import would GRANT (permission mode, tool rules, connector enablement, program
 *    authority, directory roles) is listed on the item. Secrets are never imported: connections and
 *    reminders are shown for reading and never written.
 *  - Every apply first takes a verified safety backup and records a restore point; undo is an
 *    import of that safety backup (see `restoreImport` and `app/backups.ts`).
 */
import { AGENT_ROLES, type AgentDef, PERMISSION_MODES, TOOL_ACCESS } from '../domain/agents.ts'
import { COVERAGE_BY_TABLE } from '../domain/backup-coverage.ts'
import { beforeReason, type RestorePoint, restorePointId } from '../domain/backups.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  type LibraryMove,
  type MoveRule,
  PathIndex,
  rewriteRef,
  rewriteText,
} from '../domain/library-moves.ts'
import {
  compareRows,
  DATASETS,
  type DataRow,
  datasetOfEntry,
  IdMap,
  parseRowsFile,
  rowLabel,
} from '../domain/workspace-data.ts'
import {
  type AgentDoc,
  agentAuthority,
  type ConnectionDoc,
  comparable,
  newLines,
  type PersonDoc,
  type ProgramDoc,
  parsePersonaMarkdown,
  personAuthority,
  personaMarkdown,
  programAuthority,
  type RoutineDoc,
  routineAuthority,
  type SettingsDoc,
} from '../domain/workspace-docs.ts'
import {
  bytesOf,
  canonicalJson,
  classify,
  defaultSelection,
  entryOfFile,
  fileOfEntry,
  GATED_SECTIONS,
  type ImportItem,
  type ImportPreview,
  type ImportSelection,
  type ImportSource,
  isSection,
  jsonFieldDiff,
  lineDiff,
  PREVIEW_ITEM_MAX,
  REFERENCE_REPORT_MAX,
  REFERENCE_SECTIONS,
  SECTIONS,
  type SectionId,
  selects,
  slugOfName,
  summarize,
  TOOL_MEDIA_PREFIX,
  textOf,
} from '../domain/workspace-export.ts'
import { openSecrets, SECRETS_FILE, type SecretRecord } from '../domain/workspace-secrets.ts'
import { archiveAgent, createAgent, updateAgent } from './agents.ts'
import { backupPort } from './backup-port.ts'
import { createBackup } from './backups.ts'
import { effectiveConfig, ensureHeartbeats, setDigest, setHeartbeat } from './heartbeat.ts'
import { editPersona } from './persona.ts'
import type { Deps } from './ports.ts'
import {
  createProgram,
  deleteProgram,
  pauseProgram,
  resumeProgram,
  updateProgram,
  updateProgramText,
} from './programs.ts'
import {
  createRoutine,
  deleteRoutine,
  pauseRoutine,
  resumeRoutine,
  updateRoutine,
} from './routines.ts'
import { patchSettings } from './settings.ts'
import {
  agentDoc,
  type ConnectionIndex,
  collectEntities,
  connectionId,
  connectionIndex,
} from './workspace-export.ts'
import {
  checkRefs,
  type PlannedMove,
  planMoves,
  programRefs,
  type RefSource,
  textRefs,
} from './workspace-moves.ts'

// --- plan --------------------------------------------------------------------------------------

interface RunCtx {
  deps: Deps
  index: ConnectionIndex
  label: string
  /** The id of an agent by slug now (an agent created earlier in this run counts). */
  agentId(slug: string): string | undefined
  /** Old id (in the zip) -> id here, for everything this run matched or created. */
  idMap: IdMap
  /** Whether items that exist here and differ are replaced. */
  overwrite: boolean
  /** Steps that run after every item (an agent is archived last, after what belongs to it is written). */
  deferred: Array<() => Promise<void>>
  /** Agents this run created: they have nothing of their own yet, so their rows are always replaced. */
  createdAgents: Set<string>
  /** People this run created: the `create` event the directory wrote is replaced by the zip's history. */
  createdPeople: Set<string>
  /** Rewrite references to moved paths (the owner ticked it). */
  rewrite: boolean
  /** Every move of the plan, as rules (what the rewrite maps through). */
  rules: readonly MoveRule[]
  /** The library paths after the planned changes (a reference that exists there is never rewritten). */
  after: PathIndex
  /** The moves this run applied (recorded in `library_moves` at the end, unless it is an undo). */
  applied: Array<Omit<LibraryMove, 'id' | 'at' | 'restorePointId'>>
  /** The keys of the plan entries that ran. */
  ran: Set<string>
}

/** One thing the import may do: its preview item and how to apply it. */
interface PlanEntry {
  item: ImportItem
  /** Applied in this order: settings, agents, routines, programs, files, people, then removals. */
  order: number
  /** Apply it; the answer is a note for the restore point. Undefined for a reference or a blocked item. */
  run?: (ctx: RunCtx) => Promise<string | undefined>
  /** The key of the section's removal (an only-in-workspace item). */
  removal?: boolean
  /** The key of an entry that must be applied too (a file written at the new path of a move). */
  requires?: string
}

const ORDER = {
  settings: 0,
  agent: 1,
  persona: 2,
  heartbeat: 3,
  connection: 3.5,
  routine: 4,
  // moves come before the programs: a brief file is where its program says by the time it is written
  move: 4.5,
  program: 5,
  file: 6,
  // references are rewritten when every file and program is where it will be
  reference: 7,
  data: 8,
  // people come after the channels data (their divisions are chats), their rows after them
  person: 8.5,
  peopleData: 8.8,
  secret: 9,
}
const REMOVAL = 100

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i])

const MAX_TEXT_DIFF_BYTES = 400_000

const looksText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 4096).includes(0)

function readableDiff(before: Uint8Array | undefined, after: Uint8Array): string | null {
  if (!looksText(after) || (before !== undefined && !looksText(before))) {
    return `binary file: ${before?.byteLength ?? 0} -> ${after.byteLength} bytes`
  }
  if (before === undefined) return null
  if (before.byteLength + after.byteLength > MAX_TEXT_DIFF_BYTES) {
    return `(too long to compare line by line: ${before.byteLength} -> ${after.byteLength} bytes)`
  }
  return lineDiff(textOf(before), textOf(after))
}

function makeItem(
  over: Partial<ImportItem> & Pick<ImportItem, 'key' | 'section' | 'kind' | 'label' | 'status'>,
): ImportItem {
  return {
    applicable: true,
    blocked: null,
    fields: [],
    diff: null,
    authority: [],
    notes: [],
    sizeBefore: null,
    sizeAfter: null,
    conflict: false,
    move: null,
    ...over,
  }
}

function json(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(textOf(bytes))
  } catch {
    throw new Error(`${what} is not valid JSON`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${what} must be a list of text`)
  }
  return v as string[]
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`${what} must be text`)
  return v
}
const orNull = (v: unknown, what: string): string | null =>
  v === null || v === undefined ? null : str(v, what)
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number`)
  return v
}
const numOrNull = (v: unknown, what: string): number | null =>
  v === null || v === undefined ? null : num(v, what)

function parseAgentDoc(raw: unknown, slug: string): AgentDoc {
  if (!isObject(raw)) throw new Error('agent.json must be an object')
  if (raw.slug !== slug)
    throw new Error(`agent.json names slug ${String(raw.slug)}, its folder is ${slug}`)
  const role = str(raw.role, 'role')
  if (!(AGENT_ROLES as readonly string[]).includes(role)) throw new Error(`unknown role: ${role}`)
  const permissionMode = str(raw.permissionMode, 'permissionMode')
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`unknown permission mode: ${permissionMode}`)
  }
  const toolAccess = orNull(raw.toolAccess, 'toolAccess')
  if (toolAccess !== null && !(TOOL_ACCESS as readonly string[]).includes(toolAccess)) {
    throw new Error(`unknown tool access: ${toolAccess}`)
  }
  const rules = isObject(raw.rules) ? raw.rules : {}
  const connectors: AgentDoc['connectors'] = {}
  if (raw.connectors !== undefined) {
    if (!isObject(raw.connectors)) throw new Error('connectors must be an object')
    for (const [k, v] of Object.entries(raw.connectors)) {
      if (!isObject(v)) throw new Error(`the choices of ${k} must be an object`)
      connectors[k] = v
    }
  }
  return {
    ...(typeof raw.id === 'string' && raw.id !== '' ? { id: raw.id } : {}),
    slug,
    archived: raw.archived === true,
    name: str(raw.name, 'name'),
    role,
    avatar: orNull(raw.avatar, 'avatar'),
    color: str(raw.color, 'color'),
    description: typeof raw.description === 'string' ? raw.description : '',
    instructions: str(raw.instructions, 'instructions'),
    model: orNull(raw.model, 'model'),
    modelProfile: orNull(raw.modelProfile, 'modelProfile'),
    toolAccess,
    taskConcurrency: num(raw.taskConcurrency, 'taskConcurrency'),
    contextWindow: numOrNull(raw.contextWindow, 'contextWindow'),
    compactAtPercent: num(raw.compactAtPercent, 'compactAtPercent'),
    skills: raw.skills === undefined ? [] : strings(raw.skills, 'skills'),
    permissionMode,
    rules: {
      allow: rules.allow === undefined ? [] : strings(rules.allow, 'rules.allow'),
      ask: rules.ask === undefined ? [] : strings(rules.ask, 'rules.ask'),
      deny: rules.deny === undefined ? [] : strings(rules.deny, 'rules.deny'),
    },
    connectors,
  }
}

function parseProgramDoc(raw: unknown): ProgramDoc {
  if (!isObject(raw)) throw new Error('the program file must be an object')
  const a = isObject(raw.authority) ? raw.authority : {}
  const trigger = isObject(raw.trigger) ? raw.trigger : { kind: 'manual' }
  if (trigger.kind !== 'manual' && !(trigger.kind === 'schedule' && isObject(trigger.spec))) {
    throw new Error('the trigger must be manual or a schedule')
  }
  const status = raw.status === 'paused' ? 'paused' : 'active'
  return {
    ...(typeof raw.id === 'string' && raw.id !== '' ? { id: raw.id } : {}),
    name: str(raw.name, 'name'),
    status,
    authority: {
      tools: a.tools === undefined ? [] : strings(a.tools, 'authority.tools'),
      connectors: a.connectors === undefined ? [] : strings(a.connectors, 'authority.connectors'),
      read: a.read === undefined ? [] : strings(a.read, 'authority.read'),
      write: a.write === undefined ? [] : strings(a.write, 'authority.write'),
    },
    gates: raw.gates === undefined ? [] : strings(raw.gates, 'gates'),
    escalation: typeof raw.escalation === 'string' ? raw.escalation : '',
    forbidden: raw.forbidden === undefined ? [] : strings(raw.forbidden, 'forbidden'),
    budget: isObject(raw.budget) ? raw.budget : {},
    trigger: trigger as ProgramDoc['trigger'],
    report: typeof raw.report === 'string' ? raw.report : 'task',
    worker: isObject(raw.worker) ? (raw.worker as { maxTasks: number }) : null,
    deliverables: Array.isArray(raw.deliverables) ? raw.deliverables : [],
    notes: raw.notes === undefined ? [] : strings(raw.notes, 'notes'),
    briefPath: typeof raw.briefPath === 'string' ? raw.briefPath : null,
    notesPath: typeof raw.notesPath === 'string' ? raw.notesPath : null,
    briefFile: typeof raw.briefFile === 'string' ? raw.briefFile : '',
  }
}

function parseRoutineDoc(raw: unknown): RoutineDoc {
  if (!isObject(raw)) throw new Error('the routine file must be an object')
  if (!isObject(raw.schedule)) throw new Error('the schedule must be an object')
  return {
    id: str(raw.id, 'id'),
    name: str(raw.name, 'name'),
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    schedule: raw.schedule,
    sessionMode: typeof raw.sessionMode === 'string' ? raw.sessionMode : 'task',
    overlap: typeof raw.overlap === 'string' ? raw.overlap : 'skip',
    catchUpWindowMs: numOrNull(raw.catchUpWindowMs, 'catchUpWindowMs'),
    maxFailures: raw.maxFailures === undefined ? 3 : num(raw.maxFailures, 'maxFailures'),
    maxFires: numOrNull(raw.maxFires, 'maxFires'),
    endAt: numOrNull(raw.endAt, 'endAt'),
    status: raw.status === 'paused' ? 'paused' : 'active',
  }
}

function parsePersonDoc(raw: unknown): PersonDoc {
  if (!isObject(raw)) throw new Error('the person file must be an object')
  const fields: Record<string, string> = {}
  if (isObject(raw.fields)) {
    for (const [k, v] of Object.entries(raw.fields)) if (typeof v === 'string') fields[k] = v
  }
  const role = orNull(raw.role, 'role')
  if (role !== null && !['owner', 'admin', 'member', 'guest'].includes(role)) {
    throw new Error(`unknown role: ${role}`)
  }
  const status = typeof raw.status === 'string' ? raw.status : 'active'
  if (!['active', 'suspended', 'left'].includes(status))
    throw new Error(`unknown status: ${status}`)
  return {
    id: str(raw.id, 'id'),
    displayName: str(raw.displayName, 'displayName'),
    nickname: orNull(raw.nickname, 'nickname'),
    status,
    role,
    divisions: raw.divisions === undefined ? [] : strings(raw.divisions, 'divisions'),
    fields,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    memberId: orNull(raw.memberId, 'memberId'),
    accounts: [],
  }
}

function parseConnectionDoc(raw: unknown): ConnectionDoc {
  if (!isObject(raw)) throw new Error('the connection file must be an object')
  const scope = typeof raw.scope === 'string' ? raw.scope : 'workspace'
  if (!['workspace', 'agent', 'user'].includes(scope)) throw new Error(`unknown scope: ${scope}`)
  return {
    ...(typeof raw.id === 'string' && raw.id !== '' ? { id: raw.id } : {}),
    label: str(raw.label, 'label'),
    connector: str(raw.connector, 'connector'),
    scope,
    agent: orNull(raw.agent, 'agent'),
    enabled: raw.enabled !== false,
    defaultEnabled: raw.defaultEnabled === true,
    settings: isObject(raw.settings) ? raw.settings : {},
    ...(isObject(raw.profile) ? { profile: raw.profile } : {}),
  }
}

function parseSettingsDoc(raw: unknown): SettingsDoc {
  if (!isObject(raw) || !isObject(raw.settings)) throw new Error('settings.json has no settings')
  return { settings: raw.settings, digest: isObject(raw.digest) ? raw.digest : {} }
}

const parsedOrError = <T>(fn: () => T): { doc: T } | { error: string } => {
  try {
    return { doc: fn() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

interface Plan {
  /** Old id (in the zip) -> id here, for what could be matched while comparing. */
  idMap: IdMap
  secrets: ImportPreview['secrets']
  entries: PlanEntry[]
  parsed: Awaited<ReturnType<ReturnType<typeof backupPort>['readWorkspace']>>
  warnings: string[]
  source: ImportPreview['source']
  label: string
  references: ImportPreview['references']
  moves: ImportPreview['moves']
  /** Every move of the plan, as rules. */
  rules: MoveRule[]
  /** The library paths after the planned changes. */
  after: PathIndex
}

const sourceOf = (source: ImportSource): ImportPreview['source'] =>
  'backupId' in source
    ? { kind: 'backup', id: source.backupId }
    : { kind: 'upload', id: source.uploadId }

/** Compare the zip with the live workspace. Reads, never writes. */
async function buildPlan(
  deps: Deps,
  source: ImportSource,
  passphrase?: string | undefined,
): Promise<Plan> {
  const port = backupPort(deps)
  const parsed = await port.readWorkspace(source)
  const zip = parsed.entries
  const live = new Map((await collectEntities(deps)).map((f) => [f.path, f.bytes]))
  const index = await connectionIndex(deps)
  const warnings: string[] = []
  const entries: PlanEntry[] = []
  const add = (e: PlanEntry): void => {
    entries.push(e)
  }

  const liveAgents = deps.agents.list({ includeArchived: true })
  const agentBySlug = new Map(liveAgents.map((a) => [a.slug, a]))
  const idBySlug = new Map(liveAgents.map((a) => [a.slug, a.id]))
  const slugById = new Map(liveAgents.map((a) => [a.id, a.slug]))
  const zipAgents = new Set<string>()
  for (const path of zip.keys()) {
    const c = classify(path)
    if (c?.kind === 'agent' && c.agent !== undefined) zipAgents.add(c.agent)
  }
  const manifestFile = new Map(parsed.manifest.files.map((f) => [f.path, f]))
  /** What changed in the workspace after this instant was changed live, not by the zip. */
  const exportedAt =
    parsed.manifest.createdAt > 0 ? parsed.manifest.createdAt : Number.POSITIVE_INFINITY
  const changedSince = (updatedAt: number | undefined): boolean =>
    updatedAt !== undefined && updatedAt > exportedAt
  const planMap = new IdMap()
  /** `conn:<label>` of every connection document of the zip: those get created by this import. */
  const zipConnectionKeys = new Set<string>()
  for (const path of zip.keys()) {
    if (classify(path)?.kind === 'connection') {
      zipConnectionKeys.add(`conn:${path.slice('connections/'.length).replace(/\.json$/, '')}`)
    }
  }

  // ---- settings
  const settingsBytes = zip.get('settings.json')
  if (settingsBytes !== undefined) {
    const r = parsedOrError(() => parseSettingsDoc(json(settingsBytes, 'settings.json')))
    const liveBytes = live.get('settings.json')
    if ('error' in r || liveBytes === undefined) {
      add({
        order: ORDER.settings,
        item: makeItem({
          key: 'settings.json',
          section: 'settings',
          kind: 'settings',
          label: 'Workspace settings',
          status: 'changed',
          applicable: false,
          blocked: 'error' in r ? r.error : 'the workspace settings cannot be read',
        }),
      })
    } else {
      const liveDoc = parseSettingsDoc(json(liveBytes, 'settings'))
      const fields = [
        ...jsonFieldDiff(liveDoc.settings, r.doc.settings).map((f) => ({
          ...f,
          field: `settings.${f.field}`,
        })),
        ...jsonFieldDiff(liveDoc.digest, r.doc.digest).map((f) => ({
          ...f,
          field: `digest.${f.field}`,
        })),
      ]
      const doc = r.doc
      add({
        order: ORDER.settings,
        item: makeItem({
          key: 'settings.json',
          section: 'settings',
          kind: 'settings',
          label: 'Workspace settings',
          status: fields.length === 0 ? 'unchanged' : 'changed',
          fields,
        }),
        run: async ({ deps: d }) => {
          const current = d.settings.get() as unknown as Record<string, unknown>
          const patch: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(doc.settings)) {
            if (
              k in current &&
              k !== 'updatedAt' &&
              canonicalJson(current[k]) !== canonicalJson(v)
            ) {
              patch[k] = v
            }
          }
          const skipped: string[] = []
          if (Object.keys(patch).length > 0) {
            try {
              patchSettings(d, patch)
            } catch {
              // one bad value (a model profile that is not here) must not hold the rest back
              for (const [k, v] of Object.entries(patch)) {
                try {
                  patchSettings(d, { [k]: v })
                } catch (error) {
                  skipped.push(`${k}: ${error instanceof Error ? error.message : String(error)}`)
                }
              }
            }
          }
          if (Object.keys(doc.digest).length > 0) {
            try {
              setDigest(d, doc.digest)
            } catch (error) {
              skipped.push(`digest: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (skipped.length > 0) return `skipped: ${skipped.join('; ')}`
          return undefined
        },
      })
    }
  }

  // ---- agents, personas, heartbeats
  const liveLead = liveAgents.find((a) => a.role === 'lead' && a.archivedAt === null)
  for (const [path, bytes] of zip) {
    const c = classify(path)
    if (c === undefined || c.agent === undefined) continue
    const slug = c.agent
    if (c.kind === 'agent') {
      const r = parsedOrError(() => parseAgentDoc(json(bytes, path), slug))
      const liveAgent = agentBySlug.get(slug)
      if ('error' in r) {
        add({
          order: ORDER.agent,
          item: makeItem({
            key: path,
            section: 'agents',
            kind: 'agent',
            label: slug,
            status: liveAgent === undefined ? 'added' : 'changed',
            applicable: false,
            blocked: r.error,
          }),
        })
        continue
      }
      const doc = r.doc
      if (doc.id !== undefined && liveAgent !== undefined) planMap.set(doc.id, liveAgent.id)
      const notes: string[] = []
      // connection keys that neither this workspace nor the zip has are dropped from the comparison and the apply
      const connectors: AgentDoc['connectors'] = {}
      for (const [key, choices] of Object.entries(doc.connectors)) {
        const id = connectionId(index, liveAgent?.id ?? '{new}', key)
        if (id === undefined && !zipConnectionKeys.has(key))
          notes.push(
            `connection "${key.replace(/^conn:/, '')}" is not in this workspace: its enablement is not imported (connect it, then enable it)`,
          )
        else connectors[key] = choices
      }
      const view: AgentDoc = { ...doc, connectors }
      const liveDoc = liveAgent === undefined ? undefined : agentDoc(liveAgent, index)
      const fields =
        liveDoc === undefined
          ? []
          : jsonFieldDiff(comparable('agent', liveDoc), comparable('agent', view))
      const archived = liveAgent?.archivedAt !== null && liveAgent !== undefined
      if (archived && doc.archived !== true) {
        notes.push('this agent is archived here: the import brings it back')
      }
      if (doc.archived === true && liveAgent === undefined) {
        notes.push('this agent is archived in the zip: it is created and archived again')
      }
      if (liveAgent !== undefined && liveAgent.role !== doc.role) {
        notes.push(`the role stays "${liveAgent.role}" (an import never changes a role)`)
      }
      const blocked =
        liveAgent === undefined && doc.role === 'lead' && liveLead !== undefined
          ? `the workspace already has a lead agent (${liveLead.slug})`
          : null
      const status =
        liveAgent === undefined
          ? 'added'
          : fields.length > 0 || (archived && doc.archived !== true)
            ? 'changed'
            : 'unchanged'
      add({
        order: ORDER.agent,
        item: makeItem({
          key: path,
          section: 'agents',
          kind: 'agent',
          label: doc.name,
          status,
          applicable: blocked === null,
          blocked,
          fields,
          notes,
          conflict: status === 'changed' && changedSince(liveAgent?.updatedAt),
          authority:
            liveDoc === undefined
              ? agentAuthority(view)
              : newLines(agentAuthority(liveDoc), agentAuthority(view)),
        }),
        run: async (ctx) => {
          const note = await applyAgent(ctx, view, liveAgent)
          return note
        },
      })
    } else if (c.kind === 'persona') {
      const r = parsedOrError(() => {
        const p = parsePersonaMarkdown(textOf(bytes))
        if (p === undefined) throw new Error('persona.md is not in the format of the export')
        return p
      })
      const liveAgent = agentBySlug.get(slug)
      const livePersona = liveAgent === undefined ? undefined : deps.persona.latest(liveAgent.id)
      if (!zipAgents.has(slug) && liveAgent === undefined) {
        add({
          order: ORDER.persona,
          item: makeItem({
            key: path,
            section: 'agents',
            kind: 'persona',
            label: `${slug} persona`,
            status: 'added',
            applicable: false,
            blocked: `the agent ${slug} is not in this workspace or in the zip`,
          }),
        })
        continue
      }
      if ('error' in r) {
        add({
          order: ORDER.persona,
          item: makeItem({
            key: path,
            section: 'agents',
            kind: 'persona',
            label: `${slug} persona`,
            status: 'changed',
            applicable: false,
            blocked: r.error,
          }),
        })
        continue
      }
      const doc = r.doc
      const liveText =
        livePersona === undefined
          ? undefined
          : personaMarkdown({
              identity: livePersona.identity,
              voice: livePersona.voice,
              operatingRules: livePersona.operatingRules,
            })
      const same =
        liveText !== undefined &&
        canonicalJson(parsePersonaMarkdown(liveText)) === canonicalJson(doc)
      const rulesChanged =
        livePersona === undefined || livePersona.operatingRules !== doc.operatingRules
      add({
        order: ORDER.persona,
        item: makeItem({
          key: path,
          section: 'agents',
          kind: 'persona',
          label: `${slug} persona`,
          // a brand-new agent made by this import gets a persona of its own: always a change
          status:
            livePersona === undefined && liveAgent === undefined
              ? 'added'
              : same
                ? 'unchanged'
                : 'changed',
          diff: liveText === undefined ? null : lineDiff(liveText, textOf(bytes)),
          authority:
            !same && rulesChanged ? ['operating rules are replaced by the text of the zip'] : [],
          sizeBefore: liveText === undefined ? null : bytesOf(liveText).byteLength,
          sizeAfter: bytes.byteLength,
        }),
        run: async (ctx) => {
          const id = ctx.agentId(slug)
          if (id === undefined) throw new Error(`the agent ${slug} does not exist`)
          editPersona(ctx.deps, id, {
            identity: doc.identity,
            voice: doc.voice,
            operatingRules: doc.operatingRules,
            reason: `Imported from ${ctx.label}`.slice(0, 500),
          })
          return undefined
        },
      })
    } else if (c.kind === 'heartbeat') {
      const r = parsedOrError(() => json(bytes, path))
      const liveAgent = agentBySlug.get(slug)
      if ('error' in r || !isObject(r.doc) || (!zipAgents.has(slug) && liveAgent === undefined)) {
        add({
          order: ORDER.heartbeat,
          item: makeItem({
            key: path,
            section: 'agents',
            kind: 'heartbeat',
            label: `${slug} heartbeat`,
            status: 'changed',
            applicable: false,
            blocked: 'error' in r ? r.error : 'the heartbeat file or its agent is not usable',
          }),
        })
        continue
      }
      const doc = r.doc
      const zipAgentDoc = parsedOrError(() =>
        parseAgentDoc(
          json(zip.get(`agents/${slug}/agent.json`) ?? new Uint8Array(), 'agent.json'),
          slug,
        ),
      )
      const role = liveAgent?.role ?? ('doc' in zipAgentDoc ? zipAgentDoc.doc.role : 'custom')
      const liveCfg = effectiveConfig(deps, { id: liveAgent?.id ?? '', role })
      const fields = jsonFieldDiff(liveCfg, { ...liveCfg, ...doc })
      add({
        order: ORDER.heartbeat,
        item: makeItem({
          key: path,
          section: 'agents',
          kind: 'heartbeat',
          label: `${slug} heartbeat`,
          status: fields.length === 0 ? 'unchanged' : liveAgent === undefined ? 'added' : 'changed',
          fields,
        }),
        run: async (ctx) => {
          await setHeartbeat(ctx.deps, slug, doc as never)
          return undefined
        },
      })
    }
  }
  // agents only in the workspace
  const zipAgentSlugs = new Set(
    [...zip.keys()].flatMap((p) =>
      classify(p)?.kind === 'agent' ? [classify(p)?.agent as string] : [],
    ),
  )
  for (const a of liveAgents) {
    if (a.archivedAt !== null || zipAgentSlugs.has(a.slug)) continue
    add({
      order: REMOVAL + ORDER.agent,
      removal: true,
      item: makeItem({
        key: `agents/${a.slug}/agent.json`,
        section: 'agents',
        kind: 'agent',
        label: a.name,
        status: 'only-live',
        applicable: a.role !== 'lead',
        conflict: changedSince(a.updatedAt),
        blocked: a.role === 'lead' ? 'the lead agent cannot be removed' : null,
        notes: ['removing an agent archives it: its chats and history stay readable'],
      }),
      run: async ({ deps: d }) => {
        archiveAgent(d, a.id)
        return undefined
      },
    })
  }

  // ---- programs
  const liveProgramPaths = [...live.keys()].filter((p) => classify(p)?.kind === 'program')
  const zipProgramPaths = new Set<string>()
  for (const [path, bytes] of zip) {
    const c = classify(path)
    if (c?.kind === 'program-brief') {
      const own = path.replace(/\.brief\.md$/, '.json')
      if (!zip.has(own)) {
        add({
          order: ORDER.program,
          item: makeItem({
            key: path,
            section: 'programs',
            kind: 'program-brief',
            label: path,
            status: 'added',
            applicable: false,
            blocked: 'the program file next to this brief is missing',
          }),
        })
      }
      continue
    }
    if (c?.kind !== 'program' || c.agent === undefined) continue
    zipProgramPaths.add(path)
    const slug = c.agent
    const briefPath = path.replace(/\.json$/, '.brief.md')
    const briefBytes = zip.get(briefPath)
    const r = parsedOrError(() => {
      if (briefBytes === undefined) throw new Error(`the brief ${briefPath} is missing`)
      return parseProgramDoc(json(bytes, path))
    })
    const liveAgent = agentBySlug.get(slug)
    if ('error' in r || (liveAgent === undefined && !zipAgents.has(slug))) {
      add({
        order: ORDER.program,
        item: makeItem({
          key: path,
          section: 'programs',
          kind: 'program',
          label: path,
          status: live.has(path) ? 'changed' : 'added',
          applicable: false,
          blocked:
            'error' in r ? r.error : `the agent ${slug} is not in this workspace or in the zip`,
        }),
      })
      continue
    }
    const doc = r.doc
    const brief = textOf(briefBytes as Uint8Array).replace(/\n$/, '')
    const liveJson = live.get(path)
    const liveBrief = live.get(briefPath)
    let fields: ImportItem['fields'] = []
    let diff: string | null = null
    let liveDoc: ProgramDoc | undefined
    if (liveJson !== undefined) {
      liveDoc = parseProgramDoc(json(liveJson, path))
      if (doc.id !== undefined && liveDoc.id !== undefined) planMap.set(doc.id, liveDoc.id)
      fields = jsonFieldDiff(
        comparable('program', { ...liveDoc, briefFile: undefined }),
        comparable('program', { ...doc, briefFile: undefined }),
      )
      if (liveBrief !== undefined) diff = lineDiff(textOf(liveBrief).replace(/\n$/, ''), brief)
    }
    const changed = fields.length > 0 || (diff !== null && diff !== '')
    const liveRecord =
      liveAgent === undefined
        ? undefined
        : deps.programs
            .list({ agentId: liveAgent.id })
            .find((p) => slugOfName(p.name) === slugOfName(doc.name))
    add({
      order: ORDER.program,
      item: makeItem({
        key: path,
        section: 'programs',
        kind: 'program',
        label: `${slug}: ${doc.name}`,
        conflict: changed && changedSince(liveRecord?.updatedAt),
        status: liveJson === undefined ? 'added' : changed ? 'changed' : 'unchanged',
        fields,
        diff: diff === '' ? null : diff,
        authority:
          liveDoc === undefined
            ? programAuthority(doc)
            : newLines(programAuthority(liveDoc), programAuthority(doc)),
      }),
      run: async (ctx) => applyProgram(ctx, slug, doc, brief),
    })
  }
  for (const path of liveProgramPaths) {
    if (zipProgramPaths.has(path)) continue
    const c = classify(path)
    const doc = parseProgramDoc(json(live.get(path) as Uint8Array, path))
    add({
      order: REMOVAL + ORDER.program,
      removal: true,
      item: makeItem({
        key: path,
        section: 'programs',
        kind: 'program',
        label: `${c?.agent}: ${doc.name}`,
        status: 'only-live',
        conflict: changedSince(
          deps.programs
            .list({})
            .find(
              (p) =>
                p.agentId === idBySlug.get(c?.agent ?? '') &&
                slugOfName(p.name) === slugOfName(doc.name),
            )?.updatedAt,
        ),
      }),
      run: async (ctx) => {
        const id = ctx.agentId(c?.agent ?? '')
        const found =
          id === undefined
            ? undefined
            : ctx.deps.programs
                .list({ agentId: id })
                .find((p) => slugOfName(p.name) === slugOfName(doc.name))
        if (found !== undefined) deleteProgram(ctx.deps, found.id)
        return undefined
      },
    })
  }

  // ---- routines (by id, then by name per agent)
  const liveRoutines = new Map<string, { path: string; doc: RoutineDoc; agent: string }>()
  for (const [path, bytes] of live) {
    const c = classify(path)
    if (c?.kind === 'routine' && c.agent !== undefined) {
      liveRoutines.set(path, { path, doc: parseRoutineDoc(json(bytes, path)), agent: c.agent })
    }
  }
  const matchedLive = new Set<string>()
  for (const [path, bytes] of zip) {
    const c = classify(path)
    if (c?.kind !== 'routine' || c.agent === undefined) continue
    const slug = c.agent
    const r = parsedOrError(() => parseRoutineDoc(json(bytes, path)))
    const liveAgent = agentBySlug.get(slug)
    if ('error' in r || (liveAgent === undefined && !zipAgents.has(slug))) {
      add({
        order: ORDER.routine,
        item: makeItem({
          key: path,
          section: 'routines',
          kind: 'routine',
          label: path,
          status: 'added',
          applicable: false,
          blocked:
            'error' in r ? r.error : `the agent ${slug} is not in this workspace or in the zip`,
        }),
      })
      continue
    }
    const doc = r.doc
    const candidates = [...liveRoutines.values()].filter(
      (l) => l.agent === slug && !matchedLive.has(l.path),
    )
    const match =
      candidates.find((l) => l.doc.id === doc.id) ??
      candidates.find((l) => l.doc.name.trim().toLowerCase() === doc.name.trim().toLowerCase())
    if (match !== undefined) {
      matchedLive.add(match.path)
      planMap.set(doc.id, match.doc.id)
    }
    const fields =
      match === undefined
        ? []
        : jsonFieldDiff(comparable('routine', match.doc), comparable('routine', doc))
    add({
      order: ORDER.routine,
      item: makeItem({
        key: path,
        section: 'routines',
        kind: 'routine',
        label: `${slug}: ${doc.name}`,
        status: match === undefined ? 'added' : fields.length > 0 ? 'changed' : 'unchanged',
        fields,
        conflict:
          fields.length > 0 && changedSince(match && deps.routines.get(match.doc.id)?.updatedAt),
        authority:
          match === undefined
            ? routineAuthority(doc)
            : newLines(routineAuthority(match.doc), routineAuthority(doc)),
      }),
      run: async (ctx) => applyRoutine(ctx, slug, doc, match?.doc.id),
    })
  }
  for (const l of liveRoutines.values()) {
    if (matchedLive.has(l.path)) continue
    add({
      order: REMOVAL + ORDER.routine,
      removal: true,
      item: makeItem({
        key: l.path,
        section: 'routines',
        kind: 'routine',
        label: `${l.agent}: ${l.doc.name}`,
        status: 'only-live',
        conflict: changedSince(deps.routines.get(l.doc.id)?.updatedAt),
      }),
      run: async ({ deps: d }) => {
        deleteRoutine(d, l.doc.id)
        return undefined
      },
    })
  }

  // ---- people (by id, then by name)
  const livePeople = new Map<string, { path: string; doc: PersonDoc }>()
  for (const [path, bytes] of live) {
    if (classify(path)?.kind === 'person')
      livePeople.set(path, { path, doc: parsePersonDoc(json(bytes, path)) })
  }
  const matchedPeople = new Set<string>()
  for (const [path, bytes] of zip) {
    if (classify(path)?.kind !== 'person') continue
    const r = parsedOrError(() => parsePersonDoc(json(bytes, path)))
    if ('error' in r) {
      add({
        order: ORDER.person,
        item: makeItem({
          key: path,
          section: 'people',
          kind: 'person',
          label: path,
          status: 'added',
          applicable: false,
          blocked: r.error,
        }),
      })
      continue
    }
    const doc = r.doc
    const candidates = [...livePeople.values()].filter((l) => !matchedPeople.has(l.path))
    const byName = candidates.filter(
      (l) => l.doc.displayName.trim().toLowerCase() === doc.displayName.trim().toLowerCase(),
    )
    const match =
      candidates.find((l) => l.doc.id === doc.id) ?? (byName.length === 1 ? byName[0] : undefined)
    if (match !== undefined) {
      matchedPeople.add(match.path)
      planMap.set(doc.id, match.doc.id)
    }
    const fields =
      match === undefined
        ? []
        : jsonFieldDiff(comparable('person', match.doc), comparable('person', doc))
    add({
      order: ORDER.person,
      item: makeItem({
        key: path,
        section: 'people',
        kind: 'person',
        label: doc.displayName,
        status: match === undefined ? 'added' : fields.length > 0 ? 'changed' : 'unchanged',
        fields,
        authority:
          match === undefined
            ? personAuthority(doc)
            : newLines(personAuthority(match.doc), personAuthority(doc)),
        notes: doc.accounts.length > 0 ? [] : [],
      }),
      run: async (ctx) => applyPerson(ctx, doc, match?.doc),
    })
  }
  for (const l of livePeople.values()) {
    if (matchedPeople.has(l.path)) continue
    add({
      order: REMOVAL + ORDER.person,
      removal: true,
      item: makeItem({
        key: l.path,
        section: 'people',
        kind: 'person',
        label: l.doc.displayName,
        status: 'only-live',
        notes: ['the platform accounts of a removed person belong to nobody (guests) until linked'],
      }),
      run: async ({ deps: d }) => {
        await d.people.remove(l.doc.id)
        return undefined
      },
    })
  }

  // ---- connections (created without secrets; the secrets section fills them in)
  const liveConnections = new Map<string, ConnectionDoc>()
  for (const [path, bytes] of live) {
    if (classify(path)?.kind === 'connection') {
      const parsedLive = parsedOrError(() => parseConnectionDoc(json(bytes, path)))
      if ('doc' in parsedLive) liveConnections.set(path, parsedLive.doc)
    }
  }
  const matchedConnections = new Set<string>()
  for (const [path, bytes] of zip) {
    if (classify(path)?.kind !== 'connection') continue
    const r = parsedOrError(() => parseConnectionDoc(json(bytes, path)))
    if ('error' in r) {
      add({
        order: ORDER.connection,
        item: makeItem({
          key: path,
          section: 'connections',
          kind: 'connection',
          label: path,
          status: 'added',
          applicable: false,
          blocked: r.error,
        }),
      })
      continue
    }
    const doc = r.doc
    const byId =
      doc.id === undefined ? undefined : [...liveConnections].find(([, d]) => d.id === doc.id)
    const liveEntry =
      byId ??
      (liveConnections.has(path)
        ? ([path, liveConnections.get(path)] as [string, ConnectionDoc])
        : undefined)
    if (liveEntry !== undefined) {
      matchedConnections.add(liveEntry[0])
      if (doc.id !== undefined && liveEntry[1].id !== undefined) {
        planMap.set(doc.id, liveEntry[1].id)
      }
    }
    const fields =
      liveEntry === undefined
        ? []
        : jsonFieldDiff(comparable('connection', liveEntry[1]), comparable('connection', doc))
    const agentGone =
      doc.scope === 'agent' &&
      (doc.agent === null ||
        doc.agent === undefined ||
        (!agentBySlug.has(doc.agent) && !zipAgents.has(doc.agent)))
    const blocked = agentGone
      ? 'the agent this connection belongs to is not in this workspace or in the zip'
      : liveEntry === undefined && deps.secrets === undefined
        ? 'connections cannot be created on this server'
        : null
    add({
      order: ORDER.connection,
      item: makeItem({
        key: path,
        section: 'connections',
        kind: 'connection',
        label: doc.label,
        status: liveEntry === undefined ? 'added' : fields.length > 0 ? 'changed' : 'unchanged',
        applicable: blocked === null,
        blocked,
        fields,
        authority:
          liveEntry === undefined
            ? [
                `connection "${doc.label}" (${doc.connector}) becomes usable by the agents it is enabled for`,
              ]
            : [],
        notes:
          liveEntry === undefined
            ? [
                'created without its secrets: tick the secrets section and enter the passphrase to restore the keys, or reconnect it',
              ]
            : [],
      }),
      run: async (ctx) => applyConnection(ctx, doc, path, zip),
    })
  }
  for (const [path, d] of liveConnections) {
    if (matchedConnections.has(path)) continue
    add({
      order: REMOVAL + ORDER.connection,
      removal: true,
      item: makeItem({
        key: path,
        section: 'connections',
        kind: 'connection',
        label: d.label,
        status: 'only-live',
        notes: [
          "removing a connection also removes its secrets and every agent's choices about it",
        ],
      }),
      run: async (ctx) => {
        const target = (await ctx.deps.connectors.connections()).find(
          (c) => !c.builtin && (c.id === d.id || c.label === d.label),
        )
        if (target !== undefined) await ctx.deps.connectors.removeConnection(target.id)
        return undefined
      },
    })
  }

  // ---- library and memory files, their moves, and the references to them
  const metas = deps.library.list({
    prefix: '/',
    excludePrefixes: [`${TOOL_MEDIA_PREFIX}/`],
    limit: 10_000_000,
  })
  const liveFileByPath = new Map(metas.map((m) => [m.path, m]))
  const readLiveBytes = async (path: string): Promise<Uint8Array | undefined> => {
    const file = await deps.library.read(path)
    return file === undefined ? undefined : (file.bytes ?? bytesOf(file.text ?? ''))
  }
  const movePlan = await planMoves({
    zip,
    live: liveFileByPath,
    readLive: readLiveBytes,
    idBySlug,
  })
  const moveKeyOf = new Map<string, string>()
  for (const m of movePlan.moves) {
    for (const f of m.files) moveKeyOf.set(f.from, m.key)
    const notes = [
      m.source === 'detected'
        ? 'found by content: a file here that the zip no longer has, and a new file with the same bytes'
        : 'stated in migrations/moves.json',
      ...(m.note === undefined ? [] : [m.note]),
      m.rule.kind === 'prefix'
        ? `a folder: ${m.files.length} file${m.files.length === 1 ? '' : 's'} move with their history`
        : 'the file moves with its history; the old path redirects agents to the new one',
    ]
    add({
      order: ORDER.move,
      item: makeItem({
        key: m.key,
        section: m.section,
        kind: 'move',
        label: `${m.rule.from} → ${m.rule.to}`,
        status: 'added',
        notes,
        move: {
          from: m.rule.from,
          to: m.rule.to,
          kind: m.rule.kind,
          files: m.files.length,
          source: m.source,
        },
      }),
      run: async (ctx) => applyMove(ctx, m),
    })
  }
  const rules: MoveRule[] = movePlan.moves.map((m) => m.rule)
  /** The library path of every file of the zip (for an agent that is known), and its entry. */
  const zipLive = new Map<string, string>()
  const zipFilePaths = new Set<string>()
  for (const [entry, bytes] of zip) {
    const c = classify(entry)
    if (c?.kind !== 'file') continue
    zipFilePaths.add(entry)
    const section: SectionId = c.section === 'memory' ? 'memory' : 'library'
    const file = manifestFile.get(entry)
    const path = fileOfEntry(entry, idBySlug)
    if (path !== undefined) zipLive.set(path, entry)
    if (path === undefined && !(c.agent !== undefined && zipAgents.has(c.agent))) {
      add({
        order: ORDER.file,
        item: makeItem({
          key: entry,
          section,
          kind: 'file',
          label: entry,
          status: 'added',
          applicable: false,
          blocked: `the agent ${c.agent} is not in this workspace or in the zip`,
          sizeAfter: bytes.byteLength,
        }),
      })
      continue
    }
    if (path?.startsWith(`${TOOL_MEDIA_PREFIX}/`)) {
      add({
        order: ORDER.file,
        item: makeItem({
          key: entry,
          section,
          kind: 'file',
          label: path,
          status: 'added',
          applicable: false,
          blocked: 'tool media is a cache of tool results and is never imported',
          sizeAfter: bytes.byteLength,
        }),
      })
      continue
    }
    // a file that moved is compared with the file it came from
    const movedFrom = path === undefined ? undefined : movePlan.targetMap.get(path)
    const counterPath = path !== undefined && liveFileByPath.has(path) ? path : movedFrom
    const meta = counterPath === undefined ? undefined : liveFileByPath.get(counterPath)
    let status: ImportItem['status'] = 'added'
    let diff: string | null = null
    let sizeBefore: number | null = null
    if (meta !== undefined && counterPath !== undefined) {
      sizeBefore = meta.size
      status = 'changed'
      const liveBytes = await readLiveBytes(counterPath)
      if (meta.size === bytes.byteLength) {
        if (liveBytes !== undefined && sameBytes(liveBytes, bytes)) status = 'unchanged'
        else if (liveBytes !== undefined) diff = readableDiff(liveBytes, bytes)
      } else {
        diff = liveBytes === undefined ? null : readableDiff(liveBytes, bytes)
      }
    }
    const requires = movedFrom === undefined ? undefined : moveKeyOf.get(movedFrom)
    add({
      order: ORDER.file,
      ...(requires === undefined ? {} : { requires }),
      item: makeItem({
        key: entry,
        section,
        kind: 'file',
        label: path ?? entry,
        status,
        diff: status === 'changed' ? diff : null,
        sizeBefore,
        sizeAfter: bytes.byteLength,
        conflict: status === 'changed' && changedSince(meta?.updatedAt),
        notes:
          movedFrom === undefined
            ? []
            : [`moved here from ${movedFrom}: compared with the file it came from`],
      }),
      run: async (ctx) => {
        const target = fileOfEntry(
          entry,
          new Map([
            ...idBySlug,
            ...(c.agent === undefined
              ? []
              : [[c.agent, ctx.agentId(c.agent) ?? ''] as [string, string]]),
          ]),
        )
        if (target === undefined || (c.agent !== undefined && ctx.agentId(c.agent) === undefined)) {
          throw new Error(`the agent ${c.agent} does not exist`)
        }
        const now = ctx.deps.library
          .list({ prefix: target, limit: 1 })
          .find((m) => m.path === target)
        const ok = await backupPort(ctx.deps).writeFile(target, bytes, {
          ifVersion: now === undefined ? null : now.version,
          mediaType: file?.mediaType ?? null,
          binary: file?.binary ?? false,
        })
        if (!ok) throw new Error('changed while importing: left as it is')
        return undefined
      },
    })
  }
  for (const m of metas) {
    // a file that moved is not "only here": it is the same file at its new path
    if (movePlan.fileMap.has(m.path)) continue
    const entry = entryOfFile(m.path, slugById)
    if (zipFilePaths.has(entry)) continue
    const c = classify(entry)
    const section: SectionId = c?.section === 'memory' ? 'memory' : 'library'
    add({
      order: REMOVAL + ORDER.file,
      removal: true,
      item: makeItem({
        key: entry,
        section,
        kind: 'file',
        label: m.path,
        status: 'only-live',
        sizeBefore: m.size,
        conflict: changedSince(m.updatedAt),
        notes: changedSince(m.updatedAt)
          ? [
              'created or changed here after the zip was exported: it is kept unless you also tick the conflicts',
            ]
          : [],
      }),
      run: async (ctx) => {
        const ok = await backupPort(ctx.deps).deleteFile(m.path, m.version)
        if (!ok) throw new Error('changed while importing: left as it is')
        return undefined
      },
    })
  }

  // ---- references: what the planned moves and changes leave pointing to nothing
  const afterPaths = new Set<string>()
  for (const p of liveFileByPath.keys()) afterPaths.add(movePlan.fileMap.get(p) ?? p)
  for (const p of zipLive.keys()) afterPaths.add(p)
  const indexes = {
    before: new PathIndex(liveFileByPath.keys()),
    after: new PathIndex(afterPaths),
    // what is left when "remove what is not in the zip" is ticked
    afterRemoved: new PathIndex([...zipLive.keys(), ...movePlan.fileMap.values()]),
  }
  const refs: RefSource[] = []
  // programs as they will be: the zip's version when it has the program, else the live one
  interface EffectiveProgram {
    slug: string
    name: string
    paths: ProgramPaths
  }
  const effective = new Map<string, EffectiveProgram>()
  const takeProgram = (agent: string, doc: ProgramDoc): void => {
    effective.set(`${agent}/${slugOfName(doc.name)}`, {
      slug: agent,
      name: doc.name,
      paths: {
        authority: { read: doc.authority.read, write: doc.authority.write },
        deliverables: doc.deliverables as Array<Record<string, unknown>>,
        briefPath: doc.briefPath ?? null,
        notesPath: doc.notesPath ?? null,
      },
    })
  }
  for (const path of liveProgramPaths) {
    const agent = classify(path)?.agent
    const r = parsedOrError(() => parseProgramDoc(json(live.get(path) as Uint8Array, path)))
    if (agent !== undefined && 'doc' in r) takeProgram(agent, r.doc)
  }
  for (const path of zipProgramPaths) {
    const agent = classify(path)?.agent
    const r = parsedOrError(() => parseProgramDoc(json(zip.get(path) as Uint8Array, path)))
    if (agent !== undefined && 'doc' in r) takeProgram(agent, r.doc)
  }
  for (const e of effective.values()) {
    refs.push(...programRefs(`Program ${e.slug}: ${e.name}`, e.paths))
  }
  // memory files as they will be (standing orders live in HEARTBEAT.md)
  const memoryText = new Map<string, { text: string; owner: string }>()
  const memoryOwner = (path: string): string => {
    const m = /^\/memories\/agents\/([^/]+)\/(.*)$/.exec(path)
    return m === null
      ? `workspace memory: ${path.replace('/memories/workspace/', '')}`
      : `${slugById.get(m[1] as string) ?? m[1]} memory: ${m[2]}`
  }
  for (const [path, entry] of zipLive) {
    const bytes = zip.get(entry) as Uint8Array
    if (path.startsWith('/memories/') && looksText(bytes) && bytes.byteLength <= 400_000) {
      memoryText.set(path, { text: textOf(bytes), owner: memoryOwner(path) })
    }
  }
  for (const m of metas) {
    if (!m.path.startsWith('/memories/') || m.binary || m.size > 400_000) continue
    const final = movePlan.fileMap.get(m.path) ?? m.path
    if (zipLive.has(m.path) || zipLive.has(final)) continue
    const file = await deps.library.read(m.path)
    if (file?.text != null) memoryText.set(final, { text: file.text, owner: memoryOwner(final) })
  }
  for (const [path, m] of memoryText) {
    const isOrders = path.endsWith('/HEARTBEAT.md')
    refs.push(
      ...textRefs(
        m.owner,
        isOrders ? 'order' : 'memory',
        isOrders ? 'standing order' : 'note',
        m.text,
      ),
    )
  }
  for (const r of deps.backups?.activeReminders() ?? []) {
    refs.push(
      ...textRefs(
        `Reminder of ${slugById.get(r.agentId) ?? r.agentId}`,
        'reminder',
        'text',
        r.body,
      ),
    )
  }
  const apiRows = deps.backups?.data.rows('api_agents') ?? []
  for (const row of apiRows) {
    const owner = `API agent ${String(row.name ?? row.id)}`
    for (const f of grantFolders(row))
      refs.push({ owner, where: 'folder grant', ref: f, kind: 'api-agent' })
  }
  const check = checkRefs(refs, indexes, rules)
  const references: ImportPreview['references'] = {
    checked: check.checked,
    dangling: check.dangling.slice(0, REFERENCE_REPORT_MAX),
    atRisk: check.atRisk.slice(0, REFERENCE_REPORT_MAX),
    rewritable: check.rewritable,
    truncated:
      check.dangling.length > REFERENCE_REPORT_MAX || check.atRisk.length > REFERENCE_REPORT_MAX,
  }
  // the one-click rewrite: each fix is an item of the preview, applied when the owner ticks it
  if (rules.length > 0) {
    for (const [path, m] of memoryText) {
      const r = rewriteText(m.text, rules, indexes.after)
      if (r.changes.length === 0) continue
      add({
        order: ORDER.reference,
        item: makeItem({
          key: `ref:memory:${path}`,
          section: 'memory',
          kind: 'reference',
          label: path,
          status: 'changed',
          diff: lineDiff(m.text, r.text),
          notes: [
            `${r.changes.length} path${r.changes.length === 1 ? '' : 's'} rewritten to where the moves put them`,
          ],
        }),
        run: async (ctx) => rewriteMemoryFile(ctx, path),
      })
    }
    for (const e of effective.values()) {
      const r = rewriteProgramPaths(e.paths, rules, indexes.after)
      if (r.fields.length === 0) continue
      add({
        order: ORDER.reference,
        item: makeItem({
          key: `ref:program:${e.slug}/${slugOfName(e.name)}`,
          section: 'programs',
          kind: 'reference',
          label: `${e.slug}: ${e.name} (paths)`,
          status: 'changed',
          fields: r.fields,
          notes: ['its paths follow the moves; what the program may read and write stays the same'],
        }),
        run: async (ctx) => rewriteProgramRun(ctx, e.slug, e.name),
      })
    }
    for (const row of apiRows) {
      const folders = grantFolders(row)
      const next = folders.map((f) => rewriteRef(f, rules, indexes.after) ?? f)
      if (canonicalJson(folders) === canonicalJson(next)) continue
      add({
        order: ORDER.reference,
        item: makeItem({
          key: `ref:api:${String(row.id)}`,
          section: 'api',
          kind: 'reference',
          label: `API agent ${String(row.name ?? row.id)} (folder grants)`,
          status: 'changed',
          fields: jsonFieldDiff({ folders }, { folders: next }),
          notes: ['the folders it may read and write follow the moves'],
        }),
        run: async (ctx) => rewriteApiRun(ctx, String(row.id)),
      })
    }
  }
  const moveSummary: ImportPreview['moves'] = {
    files: movePlan.moves.reduce((n, m) => n + m.files.length, 0),
    folders: movePlan.moves.filter((m) => m.rule.kind === 'prefix').length,
    explicit: movePlan.moves.filter((m) => m.source === 'moves.json').length,
    detected: movePlan.moves.filter((m) => m.source === 'detected').length,
  }
  warnings.push(...movePlan.problems)
  if (parsed.edited.changed + parsed.edited.added + parsed.edited.removed > 0) {
    warnings.push(
      `This zip was reorganized offline: ${parsed.edited.changed} library or memory files differ from the manifest, ${parsed.edited.added} are new and ${parsed.edited.removed} are gone. Files are compared with what is here, not with the manifest.`,
    )
  }

  // ---- data tables (rows: persona history, reminders, channels, history, artifacts, API, browser, conversations)
  for (const spec of DATASETS) {
    const partPaths = [...zip.keys()].filter((p) => datasetOfEntry(p)?.table === spec.table).sort()
    if (partPaths.length === 0) continue
    const feature = COVERAGE_BY_TABLE.get(spec.table)?.feature ?? spec.table
    const label = `${feature} (${spec.table})`
    let zipRows: DataRow[] = []
    let problem: string | null = null
    try {
      for (const path of partPaths) {
        zipRows = zipRows.concat(parseRowsFile(textOf(zip.get(path) as Uint8Array), spec).rows)
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    if (problem !== null || deps.backups === undefined) {
      add({
        order: ORDER.data,
        item: makeItem({
          key: `data/${spec.table}`,
          section: spec.section,
          kind: 'data',
          label,
          status: 'added',
          applicable: false,
          blocked: problem ?? 'this server has no backups',
        }),
      })
      continue
    }
    const liveRows = deps.backups.data.rows(spec.table)
    const cmp = compareRows(
      spec,
      zipRows.map((r) => planMap.row(r)),
      liveRows,
    )
    const names = (rows: DataRow[], mark: string): string[] =>
      rows.slice(0, 12).map((r) => `${mark} ${rowLabel(spec, r)}`)
    const diffLines = [
      ...names(cmp.added, '+'),
      ...names(
        cmp.changed.map((c) => c.after),
        '~',
      ),
    ]
    const extra = cmp.added.length + cmp.changed.length - diffLines.length
    add({
      order: spec.section === 'people' ? ORDER.peopleData : ORDER.data,
      item: makeItem({
        key: `data/${spec.table}`,
        section: spec.section,
        kind: 'data',
        label,
        status: cmp.added.length > 0 ? 'added' : cmp.changed.length > 0 ? 'changed' : 'unchanged',
        fields: [
          {
            field: 'rows',
            before: `${liveRows.length} here`,
            after: `${zipRows.length} in the zip (${cmp.added.length} new, ${cmp.changed.length} changed, ${cmp.same} equal)`,
          },
        ],
        diff:
          diffLines.length === 0
            ? null
            : `${diffLines.join('\n')}${extra > 0 ? `\n... ${extra} more` : ''}`,
        notes:
          cmp.changed.length > 0
            ? ['rows that differ are replaced only when you choose to overwrite']
            : [],
      }),
      run: async (ctx) => {
        const port = (ctx.deps.backups as NonNullable<Deps['backups']>).data
        const rows = zipRows.map((r) => ctx.idMap.row(r))
        // what belongs to an agent this run created is replaced: that agent has no history of its own yet
        const own = (r: DataRow): boolean =>
          typeof r.agent_id === 'string' && ctx.createdAgents.has(r.agent_id)
        if (spec.table === 'people_events' && ctx.createdPeople.size > 0) {
          const auto = port
            .rows('people_events')
            .filter((r) => typeof r.person_id === 'string' && ctx.createdPeople.has(r.person_id))
          port.remove('people_events', auto)
        }
        const mine = rows.filter(own)
        const rest = rows.filter((r) => !own(r))
        const a = port.put(spec.table, mine, 'replace')
        const b = port.put(spec.table, rest, ctx.overwrite ? 'replace' : 'ignore')
        return `${a.added + b.added} rows added, ${a.updated + b.updated} updated`
      },
    })
    if (cmp.onlyLive.length > 0) {
      add({
        order: REMOVAL + ORDER.data,
        removal: true,
        item: makeItem({
          key: `data/${spec.table}#only-live`,
          section: spec.section,
          kind: 'data',
          label: `${label}: ${cmp.onlyLive.length} rows only here`,
          status: 'only-live',
          diff: names(cmp.onlyLive, '-').join('\n'),
        }),
        run: async (ctx) => {
          const removed = (ctx.deps.backups as NonNullable<Deps['backups']>).data.remove(
            spec.table,
            cmp.onlyLive,
          )
          return `${removed} rows removed`
        },
      })
    }
  }

  // ---- secrets (encrypted in the zip; listed by name once the passphrase opens them)
  const secretsBytes = zip.get(SECRETS_FILE)
  const secrets: ImportPreview['secrets'] = {
    included: secretsBytes !== undefined,
    count: parsed.manifest.secrets.count,
    unlocked: false,
  }
  if (secretsBytes !== undefined && passphrase !== undefined && passphrase !== '') {
    // a wrong passphrase throws here: nothing is previewed or applied from the secrets
    const records = await openSecrets(secretsBytes, passphrase)
    secrets.unlocked = true
    const port = deps.secrets
    const liveByKey = new Map(
      port === undefined ? [] : (await port.list()).map((r) => [r.key, r] as const),
    )
    const liveAgentIds = new Set(liveAgents.map((a) => a.id))
    // agents the zip brings (their ids in the zip): a connection of one of them is created with it
    const zipAgentIds = new Set<string>()
    for (const [path, bytes] of zip) {
      if (classify(path)?.kind !== 'agent') continue
      const d = parsedOrError(() => json(bytes, path))
      if ('doc' in d && isObject(d.doc) && typeof d.doc.id === 'string') zipAgentIds.add(d.doc.id)
    }
    for (const original of records) {
      const record = remapRecord(original, planMap)
      const live = liveByKey.get(record.key)
      const scopeId = scopeOf(record)
      const blocked =
        port === undefined
          ? 'secrets cannot be restored on this server'
          : scopeId !== null &&
              !liveAgentIds.has(scopeId) &&
              !zipAgentIds.has(scopeId) &&
              !zipAgentIds.has(scopeOf(original) ?? '')
            ? 'the agent this connection belongs to is not in this workspace or in the zip'
            : null
      const status: ImportItem['status'] =
        live === undefined
          ? 'added'
          : fingerprint(live) === fingerprint(record)
            ? 'unchanged'
            : 'changed'
      add({
        order: ORDER.secret,
        item: makeItem({
          key: `secrets/${record.key}`,
          section: 'secrets',
          kind: 'secrets',
          label: `${secretKindText(record.key)}: ${record.label}`,
          status,
          applicable: blocked === null,
          blocked,
          authority:
            status === 'unchanged'
              ? []
              : [`${secretKindText(record.key)} "${record.label}" becomes usable by the agents`],
          notes:
            status === 'changed'
              ? ['a different secret is stored here (values are never shown)']
              : [],
        }),
        run: async (ctx) => {
          await (ctx.deps.secrets as NonNullable<Deps['secrets']>).put(
            remapRecord(original, ctx.idMap),
          )
          return undefined
        },
      })
    }
  }

  // what belongs to an agent that is archived here waits for the agent to come back
  for (const e of entries) {
    const slug = e.removal === true ? undefined : classify(e.item.key)?.agent
    if (slug === undefined || e.item.kind === 'agent' || e.item.status === 'unchanged') continue
    if (agentBySlug.get(slug)?.archivedAt !== null && agentBySlug.has(slug)) {
      e.item.notes.push(
        'the agent is archived here: this is applied only together with the agent (overwrite brings it back)',
      )
    }
  }

  const label = 'backupId' in source ? `backup ${source.backupId}` : 'uploaded zip'
  if (parsed.manifest.excluded.length > 0) {
    warnings.push('Tool media (a cache) is not part of the zip and is never touched.')
  }
  return {
    entries,
    parsed,
    warnings,
    source: sourceOf(source),
    label,
    secrets,
    idMap: planMap,
    references,
    moves: moveSummary,
    rules,
    after: indexes.after,
  }
}

const SECRET_KIND_TEXT: Record<string, string> = {
  provider: 'Model provider key',
  connection: 'Connection credentials',
  'connector-client': 'OAuth client',
  'api-key': 'API key',
  'artifact-share': 'Artifact share link',
}
const secretKindText = (key: string): string =>
  SECRET_KIND_TEXT[key.split('/')[0] ?? ''] ?? 'Secret'

/** The agent a connection record belongs to (agent scope), or null. */
function scopeOf(record: SecretRecord): string | null {
  const row = record.rows.find((r) => r.kind === 'connection')
  return row !== undefined &&
    row.profile.scope === 'agent' &&
    typeof row.profile.scopeId === 'string'
    ? row.profile.scopeId
    : null
}

/** What makes two secret records equal: every row's profile without its write time. Kept in memory only. */
function fingerprint(record: SecretRecord): string {
  return canonicalJson(
    [...record.rows]
      .sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1))
      .map((r) => ({
        kind: r.kind,
        id: r.id,
        profile: { ...r.profile, updatedAt: undefined, last_used_at: undefined },
      })),
  )
}

/** The record with the agent id of a connection mapped to the id here. */
function remapRecord(record: SecretRecord, map: IdMap): SecretRecord {
  if (map.size === 0) return record
  return {
    ...record,
    rows: record.rows.map((row) =>
      row.kind === 'connection' && typeof row.profile.scopeId === 'string'
        ? { ...row, profile: { ...row.profile, scopeId: map.get(row.profile.scopeId) } }
        : row,
    ),
  }
}

// --- moves and references: helpers --------------------------------------------------------------

/** The library paths a program names. */
interface ProgramPaths {
  authority: { read: string[]; write: string[] }
  deliverables: Array<Record<string, unknown>>
  briefPath: string | null
  notesPath: string | null
}

/** The paths of a program moved to where the moves put them (only the ones that point to nothing). */
function rewriteProgramPaths(
  p: ProgramPaths,
  rules: readonly MoveRule[],
  after: PathIndex,
): { next: ProgramPaths; fields: ImportItem['fields'] } {
  const map = (x: string): string => rewriteRef(x, rules, after) ?? x
  const next: ProgramPaths = {
    authority: { read: p.authority.read.map(map), write: p.authority.write.map(map) },
    deliverables: p.deliverables.map((d) =>
      typeof d.path === 'string' ? { ...d, path: map(d.path) } : d,
    ),
    briefPath: p.briefPath === null ? null : map(p.briefPath),
    notesPath: p.notesPath === null ? null : map(p.notesPath),
  }
  const pick = (v: ProgramPaths): unknown => ({
    ...v,
    deliverables: v.deliverables.map((d) => d.path),
  })
  return { next, fields: jsonFieldDiff(pick(p), pick(next)) }
}

/** The folders an API agent may read and write (the stored row keeps them as JSON text or a list). */
function grantFolders(row: DataRow): string[] {
  let read: unknown = row.read_folders
  if (typeof read === 'string') {
    try {
      read = JSON.parse(read)
    } catch {
      read = []
    }
  }
  const folders = Array.isArray(read) ? read.filter((f): f is string => typeof f === 'string') : []
  return typeof row.write_folder === 'string' && row.write_folder !== ''
    ? [...folders, row.write_folder]
    : folders
}

/** Move the files of one planned move; a file that cannot move is told, the rest still move. */
async function applyMove(ctx: RunCtx, m: PlannedMove): Promise<string | undefined> {
  const port = backupPort(ctx.deps)
  const done: Array<{ from: string; to: string }> = []
  const failed: string[] = []
  for (const f of m.files) {
    const result = await port.moveFile(f.from, f.to, null)
    if (result === 'ok') done.push(f)
    else failed.push(`${f.from} (${result})`)
  }
  if (done.length === 0) throw new Error(`nothing moved: ${failed.slice(0, 3).join(', ')}`)
  const note = m.note ?? null
  if (m.rule.kind === 'prefix' && failed.length === 0) {
    ctx.applied.push({ from: m.rule.from, to: m.rule.to, kind: 'prefix', note })
  } else {
    for (const f of done) ctx.applied.push({ from: f.from, to: f.to, kind: 'file', note })
  }
  ctx.ran.add(m.key)
  return failed.length === 0
    ? `${done.length} file${done.length === 1 ? '' : 's'} moved`
    : `${done.length} moved, ${failed.length} not moved: ${failed.slice(0, 3).join(', ')}`
}

/** The text of a memory file with its references to moved paths rewritten (what is there now). */
async function rewriteMemoryFile(ctx: RunCtx, path: string): Promise<string | undefined> {
  const file = await ctx.deps.library.read(path)
  if (file?.text == null) return undefined
  const r = rewriteText(file.text, ctx.rules, ctx.after)
  if (r.changes.length === 0) return undefined
  const ok = await backupPort(ctx.deps).writeFile(path, bytesOf(r.text), {
    ifVersion: file.meta.version,
    mediaType: file.meta.mediaType,
    binary: false,
  })
  if (!ok) throw new Error('changed while importing: left as it is')
  return `${r.changes.length} path${r.changes.length === 1 ? '' : 's'} rewritten`
}

/** The paths of a program (as it is now) moved to where the moves put them. */
async function rewriteProgramRun(
  ctx: RunCtx,
  slug: string,
  name: string,
): Promise<string | undefined> {
  const agentId = ctx.agentId(slug)
  const program =
    agentId === undefined
      ? undefined
      : ctx.deps.programs.list({ agentId }).find((p) => slugOfName(p.name) === slugOfName(name))
  if (program === undefined) return undefined
  const { next, fields } = rewriteProgramPaths(
    {
      authority: { read: program.authority.read, write: program.authority.write },
      deliverables: program.deliverables as unknown as Array<Record<string, unknown>>,
      briefPath: program.briefPath,
      notesPath: program.notesPath,
    },
    ctx.rules,
    ctx.after,
  )
  if (fields.length === 0) return undefined
  const notes: string[] = []
  updateProgram(ctx.deps, program.id, {
    authority: { ...program.authority, read: next.authority.read, write: next.authority.write },
    deliverables: next.deliverables as never,
  })
  if (next.briefPath !== program.briefPath || next.notesPath !== program.notesPath) {
    try {
      updateProgram(ctx.deps, program.id, {
        briefPath: next.briefPath,
        notesPath: next.notesPath,
      })
    } catch (error) {
      notes.push(
        `brief and notes files kept: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return `${fields.length} field${fields.length === 1 ? '' : 's'} rewritten${notes.length === 0 ? '' : `; ${notes.join('; ')}`}`
}

/** The folder grants of an API agent moved to where the moves put them. */
async function rewriteApiRun(ctx: RunCtx, id: string): Promise<string | undefined> {
  const port = (ctx.deps.backups as NonNullable<Deps['backups']>).data
  const row = port.rows('api_agents').find((r) => r.id === id)
  if (row === undefined) return undefined
  const map = (f: string): string => rewriteRef(f, ctx.rules, ctx.after) ?? f
  let read: unknown = row.read_folders
  const wasText = typeof read === 'string'
  if (typeof read === 'string') {
    try {
      read = JSON.parse(read)
    } catch {
      read = []
    }
  }
  const folders = Array.isArray(read) ? read.filter((f): f is string => typeof f === 'string') : []
  const nextRead = folders.map(map)
  const nextWrite = typeof row.write_folder === 'string' ? map(row.write_folder) : row.write_folder
  if (canonicalJson(folders) === canonicalJson(nextRead) && nextWrite === row.write_folder) {
    return undefined
  }
  port.put(
    'api_agents',
    [
      {
        ...row,
        read_folders: wasText ? JSON.stringify(nextRead) : nextRead,
        write_folder: nextWrite,
      },
    ],
    'replace',
  )
  return 'folder grants rewritten'
}

// --- apply helpers -----------------------------------------------------------------------------

async function applyAgent(
  ctx: RunCtx,
  doc: AgentDoc,
  liveAgent: AgentDef | undefined,
): Promise<string | undefined> {
  const { deps } = ctx
  const notes: string[] = []
  const known = deps.providers.profileIds()
  let model = doc.model
  let modelProfile = doc.modelProfile
  if (modelProfile !== null && !known.includes(modelProfile)) {
    notes.push(`model profile ${modelProfile} is not here: the agent uses the workspace default`)
    model = null
    modelProfile = null
  }
  const translate = (agentId: string): AgentDef['connectors'] => {
    const out: Record<string, unknown> = {}
    for (const [key, choices] of Object.entries(doc.connectors)) {
      const id = connectionId(ctx.index, agentId, key)
      if (id !== undefined) out[id] = choices
    }
    return out as AgentDef['connectors']
  }
  const fields = {
    name: doc.name,
    description: doc.description,
    instructions: doc.instructions,
    avatar: doc.avatar,
    color: doc.color,
    model,
    modelProfile,
    toolAccess: doc.toolAccess as AgentDef['toolAccess'],
    taskConcurrency: doc.taskConcurrency,
    contextWindow: doc.contextWindow,
    compactAtPercent: doc.compactAtPercent,
    skills: doc.skills,
    permissionMode: doc.permissionMode as AgentDef['permissionMode'],
    rules: doc.rules,
  }
  if (liveAgent === undefined) {
    const created = createAgent(deps, {
      ...(doc.id === undefined ? {} : { id: doc.id }),
      slug: doc.slug,
      role: doc.role as AgentDef['role'],
      ...fields,
    })
    updateAgent(deps, created.id, { connectors: translate(created.id) })
    ctx.createdAgents.add(created.id)
    if (doc.id !== undefined) ctx.idMap.set(doc.id, created.id)
    if (doc.archived === true) deferArchive(ctx, created.id, doc.role, notes)
  } else {
    let current = deps.agents.get(liveAgent.id) as AgentDef
    if (doc.id !== undefined) ctx.idMap.set(doc.id, current.id)
    if (current.archivedAt !== null && doc.archived !== true) {
      const revived: AgentDef = {
        ...current,
        archivedAt: null,
        version: current.version + 1,
        updatedAt: deps.clock.now(),
      }
      if (!deps.agents.update(revived, current.version)) {
        throw conflict('the agent was changed concurrently', 'VERSION_CONFLICT')
      }
      current = revived
    }
    if (current.archivedAt === null || doc.archived !== true) {
      updateAgent(deps, current.id, { ...fields, connectors: translate(current.id) })
    }
    if (doc.archived === true && current.archivedAt === null) {
      deferArchive(ctx, current.id, current.role, notes)
    }
  }
  return notes.length === 0 ? undefined : notes.join('; ')
}

/** An agent that is archived in the zip is archived after everything that belongs to it was written. */
function deferArchive(ctx: RunCtx, id: string, role: string, notes: string[]): void {
  if (role === 'lead') {
    notes.push('the lead agent cannot be archived: it stays active')
    return
  }
  ctx.deferred.push(async () => {
    archiveAgent(ctx.deps, id)
  })
}

async function applyProgram(
  ctx: RunCtx,
  slug: string,
  zipDoc: ProgramDoc,
  brief: string,
): Promise<string | undefined> {
  const { deps } = ctx
  // the program of the zip names the paths of the zip's library: where a file moved, follow it (the
  // brief file would otherwise be written back at its old path)
  let doc = zipDoc
  if (ctx.rewrite && ctx.rules.length > 0) {
    const r = rewriteProgramPaths(
      {
        authority: { read: zipDoc.authority.read, write: zipDoc.authority.write },
        deliverables: zipDoc.deliverables as Array<Record<string, unknown>>,
        briefPath: zipDoc.briefPath ?? null,
        notesPath: zipDoc.notesPath ?? null,
      },
      ctx.rules,
      ctx.after,
    )
    doc = {
      ...zipDoc,
      authority: {
        ...zipDoc.authority,
        read: r.next.authority.read,
        write: r.next.authority.write,
      },
      deliverables: r.next.deliverables as ProgramDoc['deliverables'],
      briefPath: r.next.briefPath,
      notesPath: r.next.notesPath,
    }
  }
  const agentId = ctx.agentId(slug)
  if (agentId === undefined) throw new Error(`the agent ${slug} does not exist`)
  const existing = deps.programs
    .list({ agentId })
    .find(
      (p) =>
        p.name.trim().toLowerCase() === doc.name.trim().toLowerCase() ||
        slugOfName(p.name) === slugOfName(doc.name),
    )
  const fields = {
    name: doc.name,
    brief,
    authority: doc.authority,
    gates: doc.gates,
    escalation: doc.escalation,
    forbidden: doc.forbidden,
    budget: doc.budget as never,
    trigger: doc.trigger as never,
    report: doc.report as never,
    worker: doc.worker,
    deliverables: doc.deliverables as never,
    notes: doc.notes,
  }
  if (existing === undefined) {
    const made = createProgram(deps, {
      ...(doc.id === undefined || doc.id === '' ? {} : { id: doc.id }),
      agentId,
      ...fields,
      status: doc.status as never,
    })
    if (doc.id !== undefined) ctx.idMap.set(doc.id, made.id)
    // file mode survives the round trip (the files themselves come with the library section)
    if (doc.briefPath != null || doc.notesPath != null) {
      updateProgram(deps, made.id, {
        briefPath: doc.briefPath ?? null,
        notesPath: doc.notesPath ?? null,
      })
    }
    return undefined
  }
  if (doc.id !== undefined) ctx.idMap.set(doc.id, existing.id)
  // a brief or notes that are library files get the new text as a new file version
  await updateProgramText(deps, existing.id, {
    ...fields,
    briefPath: doc.briefPath ?? null,
    notesPath: doc.notesPath ?? null,
  })
  const now = deps.programs.get(existing.id)
  if (now !== undefined && now.status !== doc.status) {
    if (doc.status === 'paused') pauseProgram(deps, existing.id)
    else resumeProgram(deps, existing.id)
  }
  return undefined
}

async function applyRoutine(
  ctx: RunCtx,
  slug: string,
  doc: RoutineDoc,
  liveId: string | undefined,
): Promise<string | undefined> {
  const { deps } = ctx
  const agentId = ctx.agentId(slug)
  if (agentId === undefined) throw new Error(`the agent ${slug} does not exist`)
  const fields = {
    name: doc.name,
    prompt: doc.prompt,
    schedule: doc.schedule as never,
    sessionMode: doc.sessionMode as never,
    overlap: doc.overlap as never,
    catchUpWindowMs: doc.catchUpWindowMs,
    maxFailures: doc.maxFailures,
    maxFires: doc.maxFires,
    endAt: doc.endAt,
  }
  if (liveId === undefined) {
    const created = createRoutine(deps, {
      ...(doc.id === '' ? {} : { id: doc.id }),
      agentId,
      ...fields,
    })
    ctx.idMap.set(doc.id, created.id)
    if (doc.status === 'paused') pauseRoutine(deps, created.id)
    return undefined
  }
  ctx.idMap.set(doc.id, liveId)
  updateRoutine(deps, liveId, fields)
  const now = deps.routines.get(liveId)
  if (now !== undefined && now.status !== doc.status) {
    if (doc.status === 'paused') pauseRoutine(deps, liveId)
    else resumeRoutine(deps, liveId)
  }
  return undefined
}

async function applyPerson(
  ctx: RunCtx,
  doc: PersonDoc,
  liveDoc: PersonDoc | undefined,
): Promise<string | undefined> {
  const { deps } = ctx
  const role = doc.role as 'owner' | 'admin' | 'member' | 'guest' | null
  const status = doc.status as 'active' | 'suspended' | 'left'
  // divisions are chats and topics: when the channels data is not here yet they are set at the end
  let postponed = false
  const withDivisions = async <T>(write: (divisions: string[]) => Promise<T>): Promise<T> => {
    try {
      return await write(doc.divisions)
    } catch (error) {
      if (doc.divisions.length === 0 || !/known chat or topic/.test(String(error))) throw error
      postponed = true
      return write([])
    }
  }
  const later = (id: string): void => {
    if (!postponed) return
    ctx.deferred.push(async () => {
      try {
        await deps.people.update(id, { divisions: doc.divisions })
      } catch {
        // the chats are not in this workspace: the person keeps no divisions
      }
    })
  }
  if (liveDoc === undefined) {
    const created = await withDivisions((divisions) =>
      deps.people.create({
        ...(doc.id === '' ? {} : { id: doc.id }),
        displayName: doc.displayName,
        nickname: doc.nickname,
        role,
        divisions,
        fields: doc.fields,
        notes: doc.notes,
      }),
    )
    ctx.idMap.set(doc.id, created.id)
    ctx.createdPeople.add(created.id)
    if (status !== 'active') await deps.people.update(created.id, { status })
    later(created.id)
    return undefined
  }
  ctx.idMap.set(doc.id, liveDoc.id)
  // fields of the person that the zip does not have are cleared
  const fields: Record<string, string | null> = { ...doc.fields }
  for (const k of Object.keys(liveDoc.fields)) if (!(k in doc.fields)) fields[k] = null
  await withDivisions((divisions) =>
    deps.people.update(liveDoc.id, {
      displayName: doc.displayName,
      nickname: doc.nickname,
      status,
      role,
      divisions,
      fields,
      notes: doc.notes,
    }),
  )
  later(liveDoc.id)
  return undefined
}

/**
 * Create the connection of a zip (without its secrets: they come with the secrets section) or
 * bring an existing one in line, then apply every agent's choices about it that the zip holds.
 */
async function applyConnection(
  ctx: RunCtx,
  doc: ConnectionDoc,
  path: string,
  zip: ReadonlyMap<string, Uint8Array>,
): Promise<string | undefined> {
  const { deps } = ctx
  const secrets = deps.secrets
  const key = `conn:${path.slice('connections/'.length).replace(/\.json$/, '')}`
  const all = await deps.connectors.connections()
  const existing = all.find(
    (c) =>
      !c.builtin &&
      ((doc.id !== undefined && c.id === doc.id) ||
        (c.label === doc.label && c.definitionId === doc.connector)),
  )
  let id: string
  let note: string | undefined
  if (existing !== undefined) {
    id = existing.id
    if (doc.id !== undefined) ctx.idMap.set(doc.id, id)
    await deps.connectors.updateConnection(id, {
      label: doc.label,
      enabled: doc.enabled,
      defaultEnabled: doc.defaultEnabled,
    })
  } else {
    if (secrets === undefined) throw new Error('connections cannot be created on this server')
    id = doc.id ?? crypto.randomUUID()
    const scopeId = doc.scope === 'agent' && doc.agent != null ? ctx.agentId(doc.agent) : undefined
    if (doc.scope === 'agent' && scopeId === undefined) {
      throw new Error(`the agent ${String(doc.agent)} does not exist`)
    }
    const row = {
      ...(doc.profile ?? {}),
      id,
      kind: 'connection',
      definitionId: doc.connector,
      label: doc.label,
      settings: doc.settings,
      enabled: doc.enabled,
      scope: doc.scope,
      ...(scopeId === undefined ? {} : { scopeId }),
      defaultEnabled: doc.defaultEnabled,
      source: 'store',
      updatedAt: deps.clock.now(),
      // there are no credentials yet: the secrets section (or a reconnect) makes it usable
      status: 'needs-auth',
      statusMessage: 'Restored without secrets: restore them with the passphrase or reconnect',
    }
    await secrets.put({
      key: `connection/${id}`,
      label: doc.label,
      rows: [{ kind: 'connection', id, profile: row }],
    })
    await secrets.changed()
    if (doc.id !== undefined) ctx.idMap.set(doc.id, id)
    note = 'created without secrets'
  }
  // what each agent chose about this connection
  for (const [entry, bytes] of zip) {
    if (classify(entry)?.kind !== 'agent') continue
    const slug = classify(entry)?.agent as string
    const parsedAgent = parsedOrError(() => parseAgentDoc(json(bytes, entry), slug))
    if ('error' in parsedAgent) continue
    const choices = parsedAgent.doc.connectors[key]
    const agentId = ctx.agentId(slug)
    if (choices === undefined || agentId === undefined) continue
    const def = deps.agents.get(agentId)
    if (def === undefined) continue
    await deps.connectors.setAgentConnectors(def, { [id]: choices as never })
  }
  return note
}

// --- the use cases -----------------------------------------------------------------------------

export function validateSelection(raw: Partial<ImportSelection> | undefined): ImportSelection {
  const base = defaultSelection()
  const sections = raw?.sections ?? base.sections
  const removeSections = raw?.removeSections ?? base.removeSections
  for (const s of [...sections, ...removeSections]) {
    if (!isSection(s)) throw invalid(`unknown section: ${s}`, 'INVALID_SELECTION')
    if (REFERENCE_SECTIONS.includes(s)) {
      throw invalid(`${s} is for reading only: it cannot be imported`, 'INVALID_SELECTION')
    }
  }
  if (removeSections.some((s) => GATED_SECTIONS.includes(s))) {
    throw invalid('Secrets are never removed by an import', 'INVALID_SELECTION')
  }
  return {
    sections,
    exclude: raw?.exclude ?? [],
    removeSections,
    overwrite: raw?.overwrite === true,
    overwriteConflicts: raw?.overwriteConflicts === true,
    rewriteReferences: raw?.rewriteReferences === true,
  }
}

/**
 * What an import of this zip would change. Writes nothing. With the `passphrase` of the export the
 * secrets are listed too (a wrong one fails with `IMPORT_PASSPHRASE`).
 */
export async function previewImport(
  deps: Deps,
  source: ImportSource,
  options: { passphrase?: string | undefined } = {},
): Promise<ImportPreview> {
  const plan = await buildPlan(deps, source, options.passphrase)
  const items = plan.entries.map((e) => e.item)
  const order = { added: 0, changed: 1, 'only-live': 2, unchanged: 3 } as const
  // moves first, then what is new, what differs, what is only here; reference rewrites last
  const rank = (i: ImportItem): number =>
    i.kind === 'move' ? -1 : i.kind === 'reference' ? 9 : order[i.status]
  const shown = items
    .filter((i) => i.status !== 'unchanged')
    .sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : 1))
  return {
    source: plan.source,
    manifest: {
      createdAt: plan.parsed.manifest.createdAt,
      appVersion: plan.parsed.manifest.app.version,
      formatVersion: plan.parsed.manifest.formatVersion,
      counts: plan.parsed.manifest.counts,
    },
    sections: summarize(items),
    secrets: plan.secrets,
    items: shown.slice(0, PREVIEW_ITEM_MAX),
    truncated: shown.length > PREVIEW_ITEM_MAX,
    warnings: plan.warnings,
    references: plan.references,
    moves: plan.moves,
  }
}

export interface ImportResult {
  /** Null when nothing was selected to change (nothing was taken or written). */
  restorePointId: string | null
  safetyBackupId: string | null
  counts: RestorePoint['counts']
  items: RestorePoint['items']
}

export interface ImportOptions {
  /** Who applies it. */
  by: string
  /** The restore point this import undoes. */
  undoOf?: string | undefined
  /** The passphrase of the export; needed when the `secrets` section is selected. */
  passphrase?: string | undefined
}

/**
 * Apply the confirmed part of an import. A verified safety backup is taken first (nothing is applied
 * when it fails) and a restore point records what was done; a failing item never stops the rest.
 */
export async function applyImport(
  deps: Deps,
  source: ImportSource,
  rawSelection: Partial<ImportSelection> | undefined,
  options: ImportOptions,
): Promise<ImportResult> {
  const port = backupPort(deps)
  const selection = validateSelection(rawSelection)
  // an undo puts back exactly what the import changed: it always overwrites, whatever changed since
  if (options.undoOf !== undefined) {
    selection.overwrite = true
    selection.overwriteConflicts = true
    selection.rewriteReferences = false
  }
  const wantsSecrets = selection.sections.includes('secrets')
  if (wantsSecrets && (options.passphrase === undefined || options.passphrase === '')) {
    throw invalid('Enter the passphrase of this export to restore its secrets', 'IMPORT_PASSPHRASE')
  }
  let undone: RestorePoint | undefined
  if (options.undoOf !== undefined) {
    undone = port.restorePoints.get(options.undoOf)
    if (undone === undefined) throw notFound('Restore point', options.undoOf)
  }
  const plan = await buildPlan(deps, source, wantsSecrets ? options.passphrase : undefined)
  const picked = plan.entries.filter((e) => e.run !== undefined && selects(e.item, selection))
  // an agent archived here that is not brought back (its change is skipped) keeps its items too
  const archived = new Set(
    deps.agents
      .list({ includeArchived: true })
      .filter((a) => a.archivedAt !== null)
      .map((a) => a.slug),
  )
  const revived = new Set(
    picked.filter((e) => e.item.kind === 'agent').map((e) => classify(e.item.key)?.agent),
  )
  const pickedKeys = new Set(picked.map((e) => e.item.key))
  const chosen = picked
    .filter((e) => {
      const slug =
        e.removal === true || e.item.kind === 'agent' ? undefined : classify(e.item.key)?.agent
      return slug === undefined || !archived.has(slug) || revived.has(slug)
    })
    // a file written at the new path of a move waits for the move: without it there is nothing to write to
    .filter((e) => e.requires === undefined || pickedKeys.has(e.requires))
    .sort((a, b) => a.order - b.order || (a.item.key < b.item.key ? -1 : 1))
  if (chosen.length === 0) {
    return {
      restorePointId: null,
      safetyBackupId: null,
      counts: { added: 0, changed: 0, removed: 0, failed: 0 },
      items: [],
    }
  }
  const safety = await createBackup(
    deps,
    beforeReason(`${options.undoOf === undefined ? 'import' : 'undo'} from ${plan.label}`),
    {
      // the backup being imported from must survive this run
      prune: false,
      // an import that touches conversations must be undoable: the safety zip holds them too
      includeConversations: chosen.some((e) => e.item.section === 'conversations'),
    },
  )
  if (!safety.ok) {
    throw conflict(
      `Nothing was imported: the safety backup failed (${safety.error})`,
      'BACKUP_FAILED',
    )
  }
  const idMap = new IdMap()
  for (const [from, to] of plan.idMap.entries()) idMap.set(from, to)
  const ctx: RunCtx = {
    deps,
    index: await connectionIndex(deps),
    label: plan.label,
    agentId: (slug) => deps.agents.getBySlug(slug)?.id,
    idMap,
    overwrite: selection.overwrite,
    deferred: [],
    createdAgents: new Set(),
    createdPeople: new Set(),
    rewrite: selection.rewriteReferences,
    rules: plan.rules,
    after: plan.after,
    applied: [],
    ran: new Set(),
  }
  const pointId = restorePointId(deps.clock.now())
  const counts = { added: 0, changed: 0, removed: 0, failed: 0 }
  const items: RestorePoint['items'] = []
  const touched = new Set<string>()
  for (const entry of chosen) {
    const { item } = entry
    try {
      const note = await (entry.run as NonNullable<PlanEntry['run']>)(ctx)
      const action =
        entry.removal === true ? 'removed' : item.status === 'added' ? 'added' : 'changed'
      counts[action]++
      touched.add(item.section)
      items.push({ key: item.key, action, ...(note === undefined ? {} : { note }) })
    } catch (error) {
      counts.failed++
      items.push({
        key: item.key,
        action: 'failed',
        note: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const step of ctx.deferred) {
    try {
      await step()
    } catch (error) {
      counts.failed++
      items.push({
        key: 'agents',
        action: 'failed',
        note: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (touched.has('secrets')) {
    try {
      await deps.secrets?.changed()
    } catch {
      // the provider profiles load again at the next change or restart
    }
  }
  // agents made by the import get their heartbeat routine like at boot
  try {
    ensureHeartbeats(deps)
  } catch {
    // the boot repairs it
  }
  const at = deps.clock.now()
  const point: RestorePoint = {
    id: pointId,
    at,
    by: options.by,
    kind: options.undoOf === undefined ? 'import' : 'undo',
    source:
      'backupId' in source
        ? { kind: 'backup', backupId: source.backupId, label: plan.label }
        : { kind: 'upload', label: plan.label },
    safetyBackupId: safety.backup.id,
    sections: [...touched],
    removedSections: selection.removeSections.filter((s) => touched.has(s)),
    counts,
    items: [
      ...items.filter((i) => i.action === 'failed'),
      ...items.filter((i) => i.action !== 'failed'),
    ].slice(0, 500),
    undoOf: options.undoOf ?? null,
    undoneBy: null,
  }
  port.restorePoints.add(point)
  if (options.undoOf !== undefined) {
    port.restorePoints.markUndone(options.undoOf, point.id)
    // the paths are back where they were: the redirects of that import end with it
    port.moves.removeOf(options.undoOf)
  } else if (ctx.applied.length > 0) {
    // what agents still call by the old path is redirected to the new one (an undo removes these)
    port.moves.add(
      ctx.applied.map(
        (m, i): LibraryMove => ({
          id: `${pointId}-${String(i + 1).padStart(4, '0')}`,
          ...m,
          at,
          restorePointId: pointId,
        }),
      ),
    )
  }
  return { restorePointId: point.id, safetyBackupId: safety.backup.id, counts, items: point.items }
}

export interface MigrationView {
  /** The restore point of the import that made these moves (undo = that restore point). */
  restorePointId: string | null
  at: number
  /** Who applied it, from the restore point. */
  by: string | null
  /** Where it came from, from the restore point (`uploaded zip`). */
  label: string | null
  files: number
  folders: number
  /** At most `MIGRATION_MOVES_MAX` moves of it, in the order they were applied. */
  moves: Array<{ from: string; to: string; kind: 'file' | 'prefix'; note: string | null }>
  /** The restore point still exists and was not undone. */
  canUndo: boolean
}

export const MIGRATION_MOVES_MAX = 200

/**
 * The moves imports applied, one entry per import, newest first. An old path in one of them still
 * works for the agents (they are redirected); undoing the import removes the entry.
 */
export function listMigrations(deps: Deps): MigrationView[] {
  const port = backupPort(deps)
  const byPoint = new Map<string, LibraryMove[]>()
  for (const m of port.moves.list()) {
    const key = m.restorePointId ?? ''
    byPoint.set(key, [...(byPoint.get(key) ?? []), m])
  }
  return [...byPoint.entries()]
    .map(([id, moves]): MigrationView => {
      const point = id === '' ? undefined : port.restorePoints.get(id)
      return {
        restorePointId: id === '' ? null : id,
        at: moves[0]?.at ?? 0,
        by: point?.by ?? null,
        label: point?.source.label ?? null,
        files: moves.filter((m) => m.kind === 'file').length,
        folders: moves.filter((m) => m.kind === 'prefix').length,
        moves: moves
          .slice(0, MIGRATION_MOVES_MAX)
          .map((m) => ({ from: m.from, to: m.to, kind: m.kind, note: m.note })),
        canUndo: point !== undefined && point.undoneBy === null && point.kind === 'import',
      }
    })
    .sort((a, b) => b.at - a.at)
}

/** The restore points, newest first. */
export function listRestorePoints(deps: Deps): RestorePoint[] {
  return backupPort(deps).restorePoints.list()
}

/**
 * What undoing a restore point means: the import of its safety backup, with every section the
 * restore point touched ticked, and the items that the import added (not in the safety backup)
 * ticked for removal. The owner sees the same preview and can untick, then confirms.
 */
export async function previewUndo(
  deps: Deps,
  id: string,
): Promise<{
  restorePoint: RestorePoint
  source: ImportSource
  selection: ImportSelection
  preview: ImportPreview
}> {
  const point = backupPort(deps).restorePoints.get(id)
  if (point === undefined) throw notFound('Restore point', id)
  if (point.undoneBy !== null) {
    throw conflict(
      'This restore point was already undone (undo the undo to get it back)',
      'ALREADY_UNDONE',
    )
  }
  const source: ImportSource = { backupId: point.safetyBackupId }
  // secrets are not part of a safety backup (it is never made with a passphrase): not undoable here
  const sections = (point.sections.filter(isSection) as SectionId[]).filter(
    (s) => !REFERENCE_SECTIONS.includes(s) && !GATED_SECTIONS.includes(s),
  )
  if (point.kind === 'database-restore') {
    throw conflict(
      'This restore point replaced the whole database: undo it with "Restore whole database" from its safety backup',
      'UNDO_DATABASE_RESTORE',
    )
  }
  const selection: ImportSelection = {
    sections: sections.length > 0 ? sections : defaultSelection().sections,
    exclude: [],
    removeSections: sections,
    overwrite: true,
    // what was changed here since is part of what an undo puts back: the preview shows it
    overwriteConflicts: true,
    rewriteReferences: false,
  }
  const preview = await previewImport(deps, source)
  if (point.sections.includes('secrets')) {
    preview.warnings.push(
      'Secrets restored by this import are not part of the undo: the safety backup holds none. The database file of that backup still has the previous ones.',
    )
  }
  return { restorePoint: point, source, selection, preview }
}

export { SECTIONS }
