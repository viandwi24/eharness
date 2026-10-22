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
 *  - What an import would GRANT (permission mode, tool rules, connector enablement, program
 *    authority, directory roles) is listed on the item. Secrets are never imported: connections and
 *    reminders are shown for reading and never written.
 *  - Every apply first takes a verified safety backup and records a restore point; undo is an
 *    import of that safety backup (see `restoreImport` and `app/backups.ts`).
 */
import { AGENT_ROLES, type AgentDef, PERMISSION_MODES, TOOL_ACCESS } from '../domain/agents.ts'
import { beforeReason, type RestorePoint, restorePointId } from '../domain/backups.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  type AgentDoc,
  agentAuthority,
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
  type ImportItem,
  type ImportPreview,
  type ImportSelection,
  type ImportSource,
  isSection,
  jsonFieldDiff,
  lineDiff,
  PREVIEW_ITEM_MAX,
  REFERENCE_SECTIONS,
  SECTIONS,
  type SectionId,
  selects,
  slugOfName,
  summarize,
  TOOL_MEDIA_PREFIX,
  textOf,
} from '../domain/workspace-export.ts'
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

// --- plan --------------------------------------------------------------------------------------

interface RunCtx {
  deps: Deps
  index: ConnectionIndex
  label: string
  /** The id of an agent by slug now (an agent created earlier in this run counts). */
  agentId(slug: string): string | undefined
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
}

const ORDER = {
  settings: 0,
  agent: 1,
  persona: 2,
  heartbeat: 3,
  routine: 4,
  program: 5,
  file: 6,
  person: 7,
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
    slug,
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
  entries: PlanEntry[]
  parsed: Awaited<ReturnType<ReturnType<typeof backupPort>['readWorkspace']>>
  warnings: string[]
  source: ImportPreview['source']
  label: string
}

const sourceOf = (source: ImportSource): ImportPreview['source'] =>
  'backupId' in source
    ? { kind: 'backup', id: source.backupId }
    : { kind: 'upload', id: source.uploadId }

/** Compare the zip with the live workspace. Reads, never writes. */
async function buildPlan(deps: Deps, source: ImportSource): Promise<Plan> {
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
      const notes: string[] = []
      // connection keys that this workspace does not have are dropped from the comparison and the apply
      const connectors: AgentDoc['connectors'] = {}
      for (const [key, choices] of Object.entries(doc.connectors)) {
        const id = connectionId(index, liveAgent?.id ?? '{new}', key)
        if (id === undefined)
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
      if (archived) notes.push('this agent is archived here: the import brings it back')
      if (liveAgent !== undefined && liveAgent.role !== doc.role) {
        notes.push(`the role stays "${liveAgent.role}" (an import never changes a role)`)
      }
      const blocked =
        liveAgent === undefined && doc.role === 'lead' && liveLead !== undefined
          ? `the workspace already has a lead agent (${liveLead.slug})`
          : null
      const status =
        liveAgent === undefined ? 'added' : fields.length > 0 || archived ? 'changed' : 'unchanged'
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
      fields = jsonFieldDiff({ ...liveDoc, briefFile: undefined }, { ...doc, briefFile: undefined })
      if (liveBrief !== undefined) diff = lineDiff(textOf(liveBrief).replace(/\n$/, ''), brief)
    }
    const changed = fields.length > 0 || (diff !== null && diff !== '')
    add({
      order: ORDER.program,
      item: makeItem({
        key: path,
        section: 'programs',
        kind: 'program',
        label: `${slug}: ${doc.name}`,
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
    if (match !== undefined) matchedLive.add(match.path)
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
    if (match !== undefined) matchedPeople.add(match.path)
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

  // ---- connections and reminders: for reading, never written
  for (const section of ['connections', 'reminders'] as const) {
    const kind = section === 'connections' ? 'connection' : 'reminder'
    const note =
      section === 'connections'
        ? 'reference only: secrets are not exported, reconnect after import'
        : 'reference only: a reminder is tied to a chat and is never imported'
    const livePaths = [...live.keys()].filter((p) => classify(p)?.kind === kind)
    for (const [path, bytes] of zip) {
      if (classify(path)?.kind !== kind) continue
      const liveBytes = live.get(path)
      let fields: ImportItem['fields'] = []
      try {
        fields =
          liveBytes === undefined ? [] : jsonFieldDiff(json(liveBytes, path), json(bytes, path))
      } catch {
        fields = []
      }
      add({
        order: ORDER.person + 1,
        item: makeItem({
          key: path,
          section,
          kind,
          label: path.replace(/^(connections|agents)\//, '').replace(/\.json$/, ''),
          status: liveBytes === undefined ? 'added' : fields.length > 0 ? 'changed' : 'unchanged',
          applicable: false,
          fields,
          notes: [note],
        }),
      })
    }
    for (const path of livePaths) {
      if (zip.has(path)) continue
      add({
        order: ORDER.person + 1,
        item: makeItem({
          key: path,
          section,
          kind,
          label: path.replace(/^(connections|agents)\//, '').replace(/\.json$/, ''),
          status: 'only-live',
          applicable: false,
          notes: [note],
        }),
      })
    }
  }

  // ---- library and memory files
  const metas = deps.library.list({
    prefix: '/',
    excludePrefixes: [`${TOOL_MEDIA_PREFIX}/`],
    limit: 10_000_000,
  })
  const liveFileByPath = new Map(metas.map((m) => [m.path, m]))
  const zipFilePaths = new Set<string>()
  for (const [entry, bytes] of zip) {
    const c = classify(entry)
    if (c?.kind !== 'file') continue
    zipFilePaths.add(entry)
    const section: SectionId = c.section === 'memory' ? 'memory' : 'library'
    const file = manifestFile.get(entry)
    const path = fileOfEntry(entry, idBySlug)
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
    const meta = path === undefined ? undefined : liveFileByPath.get(path)
    let status: ImportItem['status'] = 'added'
    let diff: string | null = null
    let sizeBefore: number | null = null
    if (meta !== undefined && path !== undefined) {
      sizeBefore = meta.size
      status = 'changed'
      if (meta.size === bytes.byteLength) {
        const liveFile = await deps.library.read(path)
        const liveBytes =
          liveFile === undefined ? undefined : (liveFile.bytes ?? bytesOf(liveFile.text ?? ''))
        if (liveBytes !== undefined && sameBytes(liveBytes, bytes)) status = 'unchanged'
        else if (liveBytes !== undefined) diff = readableDiff(liveBytes, bytes)
      } else {
        const liveFile = await deps.library.read(path)
        const liveBytes =
          liveFile === undefined ? undefined : (liveFile.bytes ?? bytesOf(liveFile.text ?? ''))
        diff = liveBytes === undefined ? null : readableDiff(liveBytes, bytes)
      }
    }
    add({
      order: ORDER.file,
      item: makeItem({
        key: entry,
        section,
        kind: 'file',
        label: path ?? entry,
        status,
        diff: status === 'changed' ? diff : null,
        sizeBefore,
        sizeAfter: bytes.byteLength,
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
      }),
      run: async (ctx) => {
        const ok = await backupPort(ctx.deps).deleteFile(m.path, m.version)
        if (!ok) throw new Error('changed while importing: left as it is')
        return undefined
      },
    })
  }

  const label = 'backupId' in source ? `backup ${source.backupId}` : 'uploaded zip'
  if (parsed.manifest.excluded.length > 0) {
    warnings.push('Tool media (a cache) is not part of the zip and is never touched.')
  }
  return { entries, parsed, warnings, source: sourceOf(source), label }
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
      slug: doc.slug,
      role: doc.role as AgentDef['role'],
      ...fields,
    })
    updateAgent(deps, created.id, { connectors: translate(created.id) })
  } else {
    let current = deps.agents.get(liveAgent.id) as AgentDef
    if (current.archivedAt !== null) {
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
    updateAgent(deps, current.id, { ...fields, connectors: translate(current.id) })
  }
  return notes.length === 0 ? undefined : notes.join('; ')
}

async function applyProgram(
  ctx: RunCtx,
  slug: string,
  doc: ProgramDoc,
  brief: string,
): Promise<string | undefined> {
  const { deps } = ctx
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
    createProgram(deps, { agentId, ...fields, status: doc.status as never })
    return undefined
  }
  updateProgram(deps, existing.id, fields)
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
    const created = createRoutine(deps, { agentId, ...fields })
    if (doc.status === 'paused') pauseRoutine(deps, created.id)
    return undefined
  }
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
  if (liveDoc === undefined) {
    const created = await deps.people.create({
      displayName: doc.displayName,
      nickname: doc.nickname,
      role,
      divisions: doc.divisions,
      fields: doc.fields,
      notes: doc.notes,
    })
    if (status !== 'active') await deps.people.update(created.id, { status })
    return undefined
  }
  // fields of the person that the zip does not have are cleared
  const fields: Record<string, string | null> = { ...doc.fields }
  for (const k of Object.keys(liveDoc.fields)) if (!(k in doc.fields)) fields[k] = null
  await deps.people.update(liveDoc.id, {
    displayName: doc.displayName,
    nickname: doc.nickname,
    status,
    role,
    divisions: doc.divisions,
    fields,
    notes: doc.notes,
  })
  return undefined
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
  return { sections, exclude: raw?.exclude ?? [], removeSections }
}

/** What an import of this zip would change. Writes nothing. */
export async function previewImport(deps: Deps, source: ImportSource): Promise<ImportPreview> {
  const plan = await buildPlan(deps, source)
  const items = plan.entries.map((e) => e.item)
  const order = { added: 0, changed: 1, 'only-live': 2, unchanged: 3 } as const
  const shown = items
    .filter((i) => i.status !== 'unchanged')
    .sort((a, b) => order[a.status] - order[b.status] || (a.key < b.key ? -1 : 1))
  return {
    source: plan.source,
    manifest: {
      createdAt: plan.parsed.manifest.createdAt,
      appVersion: plan.parsed.manifest.app.version,
      formatVersion: plan.parsed.manifest.formatVersion,
      counts: plan.parsed.manifest.counts,
    },
    sections: summarize(items),
    items: shown.slice(0, PREVIEW_ITEM_MAX),
    truncated: shown.length > PREVIEW_ITEM_MAX,
    warnings: plan.warnings,
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
  let undone: RestorePoint | undefined
  if (options.undoOf !== undefined) {
    undone = port.restorePoints.get(options.undoOf)
    if (undone === undefined) throw notFound('Restore point', options.undoOf)
  }
  const plan = await buildPlan(deps, source)
  const chosen = plan.entries
    .filter((e) => e.run !== undefined && selects(e.item, selection))
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
    },
  )
  if (!safety.ok) {
    throw conflict(
      `Nothing was imported: the safety backup failed (${safety.error})`,
      'BACKUP_FAILED',
    )
  }
  const ctx: RunCtx = {
    deps,
    index: await connectionIndex(deps),
    label: plan.label,
    agentId: (slug) => deps.agents.getBySlug(slug)?.id,
  }
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
  // agents made by the import get their heartbeat routine like at boot
  try {
    ensureHeartbeats(deps)
  } catch {
    // the boot repairs it
  }
  const at = deps.clock.now()
  const point: RestorePoint = {
    id: restorePointId(at),
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
  if (options.undoOf !== undefined) port.restorePoints.markUndone(options.undoOf, point.id)
  return { restorePointId: point.id, safetyBackupId: safety.backup.id, counts, items: point.items }
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
  const sections = (point.sections.filter(isSection) as SectionId[]).filter(
    (s) => !REFERENCE_SECTIONS.includes(s),
  )
  const selection: ImportSelection = {
    sections: sections.length > 0 ? sections : defaultSelection().sections,
    exclude: [],
    removeSections: sections,
  }
  return { restorePoint: point, source, selection, preview: await previewImport(deps, source) }
}

export { SECTIONS }
