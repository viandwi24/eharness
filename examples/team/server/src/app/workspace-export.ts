/**
 * The workspace export, app side: collect the entity documents (settings, agents, personas,
 * heartbeats, programs, routines, reminders, connections without secrets, people) from the live
 * workspace. The library and memory files are written by `infra/backup` from the database; the
 * zip itself, its manifest and its hashes too. Reading it back is `workspace-import.ts`.
 */
import type { AgentDef } from '../domain/agents.ts'
import { conflict } from '../domain/errors.ts'
import { chunkRows, DATASETS, dataEntry, type SectionId } from '../domain/workspace-data.ts'
import {
  type AgentDoc,
  type ConnectionDoc,
  type PersonDoc,
  type ProgramDoc,
  personaMarkdown,
  publicSettings,
  type RoutineDoc,
  SECRETS_NOTE,
  type SettingsDoc,
} from '../domain/workspace-docs.ts'
import {
  bytesOf,
  canonicalJson,
  type EntityFile,
  slugOfName,
  uniqueName,
} from '../domain/workspace-export.ts'
import { checkPassphrase, SECRETS_FILE, sealSecrets } from '../domain/workspace-secrets.ts'
import { backupPort } from './backup-port.ts'
import { effectiveConfig } from './heartbeat.ts'
import type { Deps } from './ports.ts'
import { resolveProgramText } from './program-files.ts'

/** How a connection is named in the export: its key in `agent.json` and its file name. */
export interface ConnectionIndex {
  /** Connection id -> key (`conn:<slug>`). */
  keyById: Map<string, string>
  /** Key -> connection id. */
  idByKey: Map<string, string>
  /** Key -> label, for reading. */
  labelByKey: Map<string, string>
  /** Key -> definition id (the connector). */
  views: Map<string, Awaited<ReturnType<Deps['connectors']['connections']>>[number]>
}

/** Connections of the workspace by a stable, readable key (their label; a repeated label gets `-2`). */
export async function connectionIndex(deps: Deps): Promise<ConnectionIndex> {
  const all = (await deps.connectors.connections())
    .filter((c) => !c.builtin)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const taken = new Set<string>()
  const index: ConnectionIndex = {
    keyById: new Map(),
    idByKey: new Map(),
    labelByKey: new Map(),
    views: new Map(),
  }
  for (const c of all) {
    const key = `conn:${uniqueName(slugOfName(c.label, 'connection'), taken)}`
    index.keyById.set(c.id, key)
    index.idByKey.set(key, c.id)
    index.labelByKey.set(key, c.label)
    index.views.set(key, c)
  }
  return index
}

const SELF = '{agent}'

/** The key of a connection id in an agent's enablement; undefined when the connection is unknown. */
export function connectionKey(
  index: ConnectionIndex,
  agentId: string,
  id: string,
): string | undefined {
  if (id.startsWith('builtin:')) return id.replaceAll(agentId, SELF)
  return index.keyById.get(id)
}

/** The connection id behind a key, in this workspace; undefined when there is none. */
export function connectionId(
  index: ConnectionIndex,
  agentId: string,
  key: string,
): string | undefined {
  if (key.startsWith('builtin:')) return key.replaceAll(SELF, agentId)
  return index.idByKey.get(key)
}

export function agentDoc(def: AgentDef, index: ConnectionIndex): AgentDoc {
  const connectors: AgentDoc['connectors'] = {}
  for (const [id, choices] of Object.entries(def.connectors)) {
    const key = connectionKey(index, def.id, id)
    // a choice about a connection that no longer exists is not worth exporting
    if (key !== undefined) connectors[key] = choices as unknown as Record<string, unknown>
  }
  return {
    id: def.id,
    slug: def.slug,
    archived: def.archivedAt !== null,
    name: def.name,
    role: def.role,
    avatar: def.avatar,
    color: def.color,
    description: def.description,
    instructions: def.instructions,
    model: def.model,
    modelProfile: def.modelProfile,
    toolAccess: def.toolAccess,
    taskConcurrency: def.taskConcurrency,
    contextWindow: def.contextWindow,
    compactAtPercent: def.compactAtPercent,
    skills: def.skills,
    permissionMode: def.permissionMode,
    rules: def.rules,
    connectors,
  }
}

const json = (path: string, value: unknown): EntityFile => ({
  path,
  bytes: bytesOf(canonicalJson(value)),
})

/** Every person of the directory with the detail the file carries. */
async function peopleDocs(deps: Deps): Promise<PersonDoc[]> {
  const out: PersonDoc[] = []
  for (let page = 1; ; page++) {
    const list = await deps.people.list({ page, limit: 100 })
    for (const item of list.items) {
      const d = await deps.people.get(item.id)
      out.push({
        id: d.id,
        displayName: d.displayName,
        nickname: d.nickname,
        status: d.status,
        role: d.role,
        divisions: d.divisions.map((x) => x.nodeId),
        fields: d.fields,
        notes: d.notes,
        memberId: d.memberId,
        accounts: d.accountViews.map((a) => ({
          platform: a.platform,
          nativeId: a.nativeId,
          label: a.label,
        })),
      })
    }
    if (page * list.limit >= list.total || list.items.length === 0) break
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export interface CollectOptions {
  /** Also carry the conversations (chat history, large). Default false. */
  includeConversations?: boolean
}

/** The sections whose data tables a collection carries. */
export const collectedSections = (options: CollectOptions): SectionId[] =>
  [...new Set(DATASETS.map((d) => d.section))].filter(
    (s) => s !== 'conversations' || options.includeConversations === true,
  )

/** The data tables of the export as chunked JSON files (`data/<table>/NNN.json`). */
export function dataFiles(deps: Deps, options: CollectOptions): EntityFile[] {
  const port = deps.backups
  if (port === undefined) return []
  const sections = new Set(collectedSections(options))
  const out: EntityFile[] = []
  for (const spec of DATASETS) {
    if (!sections.has(spec.section)) continue
    const parts = chunkRows(port.data.rows(spec.table))
    parts.forEach((rows, i) => {
      out.push(
        json(dataEntry(spec.table, i + 1), {
          format: 'eharness-team-rows',
          table: spec.table,
          part: i + 1,
          rows,
        }),
      )
    })
  }
  return out
}

/**
 * The entity documents of the live workspace. Never throws for the content: a person-readable
 * folder tree, secrets absent (connections list their settings without secrets).
 */
export async function collectEntities(
  deps: Deps,
  options: CollectOptions = {},
): Promise<EntityFile[]> {
  const files: EntityFile[] = []
  const index = await connectionIndex(deps)
  const { updatedAt: _u, ...settings } = deps.settings.get()
  const settingsDoc: SettingsDoc = {
    settings,
    digest: { ...deps.heartbeat.store.digestConfig() },
  }
  files.push(json('settings.json', settingsDoc))

  const agents = deps.agents.list({ includeArchived: true })
  const agentById = new Map(agents.map((a) => [a.id, a]))
  const usedBy = new Map<string, Record<string, unknown>>()
  for (const def of agents) {
    const base = `agents/${def.slug}`
    const doc = agentDoc(def, index)
    files.push(json(`${base}/agent.json`, doc))
    const persona = deps.persona.latest(def.id)
    if (persona !== undefined) {
      files.push({
        path: `${base}/persona.md`,
        bytes: bytesOf(
          personaMarkdown({
            identity: persona.identity,
            voice: persona.voice,
            operatingRules: persona.operatingRules,
          }),
        ),
      })
    }
    files.push(json(`${base}/heartbeat.json`, effectiveConfig(deps, def)))
    for (const [key, choices] of Object.entries(doc.connectors)) {
      if (key.startsWith('conn:')) {
        usedBy.set(key, { ...(usedBy.get(key) ?? {}), [def.slug]: choices })
      }
    }

    const taken = new Set<string>()
    for (const p of deps.programs.list({ agentId: def.id })) {
      const name = uniqueName(slugOfName(p.name, 'program'), taken)
      const current = (await resolveProgramText(deps, p, { raise: false })).program
      const programDoc: ProgramDoc = {
        id: p.id,
        name: p.name,
        status: p.status,
        authority: p.authority,
        gates: p.gates,
        escalation: p.escalation,
        forbidden: p.forbidden,
        budget: { ...p.budget },
        trigger: p.trigger as ProgramDoc['trigger'],
        report: p.report,
        worker: p.worker,
        deliverables: p.deliverables as unknown[],
        // in file mode the zip carries the current file text (the file itself is in library/)
        notes: current.notes,
        ...(p.briefPath == null ? {} : { briefPath: p.briefPath }),
        ...(p.notesPath == null ? {} : { notesPath: p.notesPath }),
        briefFile: `${name}.brief.md`,
      }
      files.push(json(`${base}/programs/${name}.json`, programDoc))
      files.push({
        path: `${base}/programs/${name}.brief.md`,
        bytes: bytesOf(`${current.brief}\n`),
      })
    }
    for (const r of deps.routines.list({ agentId: def.id })) {
      const routineDoc: RoutineDoc = {
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        schedule: r.schedule as unknown as Record<string, unknown>,
        sessionMode: r.sessionMode,
        overlap: r.overlap,
        catchUpWindowMs: r.catchUpWindowMs,
        maxFailures: r.maxFailures,
        maxFires: r.maxFires,
        endAt: r.endAt,
        status: r.status,
      }
      files.push(json(`${base}/routines/${r.id}.json`, routineDoc))
    }
  }

  for (const r of deps.backups?.activeReminders() ?? []) {
    const agent = agentById.get(r.agentId)
    if (agent === undefined) continue
    const { agentId: _a, ...rest } = r
    files.push(
      json(`agents/${agent.slug}/reminders/${r.id}.json`, {
        ...rest,
        note: 'a reminder is tied to a chat: listed for reading, never imported',
      }),
    )
  }

  const rows = new Map(
    ((await deps.secrets?.connectionRows()) ?? []).map((r) => [r.id, r.profile] as const),
  )
  for (const [key, view] of index.views) {
    const stored = rows.get(view.id)
    let profile: Record<string, unknown> | undefined
    if (stored !== undefined) {
      const {
        id: _id,
        kind: _kind,
        definitionId: _d,
        label: _l,
        enabled: _e,
        source: _src,
        updatedAt: _u,
        scope: _s,
        scopeId: _si,
        defaultEnabled: _de,
        ...rest
      } = stored
      profile = rest
    }
    const doc: ConnectionDoc = {
      id: view.id,
      label: view.label,
      connector: view.definitionId,
      scope: view.scope,
      ...(view.scope === 'agent' && view.scopeId !== undefined
        ? { agent: agentById.get(view.scopeId)?.slug ?? null }
        : {}),
      enabled: view.enabled,
      defaultEnabled: view.defaultEnabled,
      settings: publicSettings(view.settings),
      ...(profile === undefined ? {} : { profile }),
      usedBy: usedBy.get(key) ?? {},
      secrets: SECRETS_NOTE,
    }
    files.push(json(`connections/${key.slice('conn:'.length)}.json`, doc))
  }

  for (const p of await peopleDocs(deps)) files.push(json(`people/${p.id}.json`, p))
  files.push(...dataFiles(deps, options))
  return files
}

/**
 * The workspace export of the live database as a zip to download now. With a `passphrase` (at least
 * 12 characters) the provider keys and connection credentials travel too, encrypted in
 * `secrets.enc.json`; without one secrets are left out. Scheduled and safety backups never hold them.
 */
export async function exportWorkspace(
  deps: Deps,
  options: { passphrase?: string | undefined; includeConversations?: boolean } = {},
) {
  const port = backupPort(deps)
  const entities = await collectEntities(deps, {
    includeConversations: options.includeConversations === true,
  })
  if (options.passphrase !== undefined) {
    const passphrase = checkPassphrase(options.passphrase)
    if (deps.secrets === undefined) {
      throw conflict('Secrets cannot be exported on this server', 'SECRETS_UNAVAILABLE')
    }
    const records = await deps.secrets.list()
    if (records.length > 0) {
      entities.push({ path: SECRETS_FILE, bytes: await sealSecrets(records, passphrase) })
    }
  }
  return port.exportNow(entities)
}
