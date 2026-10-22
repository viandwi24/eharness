/**
 * The documents of the workspace export: their shapes, the persona as Markdown, what a document
 * would grant when imported (`authority`), and the part of a document an import compares and
 * applies (`comparable`). Pure.
 */
import { canonicalJson } from './workspace-export.ts'

/** The note every connection file carries. */
export const SECRETS_NOTE = 'secrets not exported: reconnect after import'

export interface AgentDoc {
  /** The id in the workspace the zip came from (an import maps it to the id here; absent in older zips). */
  id?: string
  slug: string
  name: string
  role: string
  avatar: string | null
  color: string
  description: string
  instructions: string
  model: string | null
  modelProfile: string | null
  toolAccess: string | null
  taskConcurrency: number
  contextWindow: number | null
  compactAtPercent: number
  skills: string[]
  permissionMode: string
  rules: { allow: string[]; ask: string[]; deny: string[] }
  /** Connector enablement by connection key (`conn:<label>`, or the id of a built-in one). */
  connectors: Record<string, Record<string, unknown>>
  /** The agent is archived (it keeps its history and can be brought back). */
  archived?: boolean
}

export interface ProgramDoc {
  /** The id in the workspace the zip came from (absent in older zips). */
  id?: string
  name: string
  status: string
  authority: { tools: string[]; connectors: string[]; read: string[]; write: string[] }
  gates: string[]
  escalation: string
  forbidden: string[]
  budget: Record<string, unknown>
  trigger: { kind: 'manual' } | { kind: 'schedule'; spec: Record<string, unknown> }
  report: string
  worker: { maxTasks: number } | null
  deliverables: unknown[]
  notes: string[]
  /** File mode (P57): the library files of the brief and the agreements; absent/null = text. */
  briefPath?: string | null
  notesPath?: string | null
  /** The brief is the Markdown file next to this one. */
  briefFile: string
}

export interface RoutineDoc {
  id: string
  name: string
  prompt: string
  schedule: Record<string, unknown>
  sessionMode: string
  overlap: string
  catchUpWindowMs: number | null
  maxFailures: number
  maxFires: number | null
  endAt: number | null
  status: string
}

/** A connection of the workspace, without its secrets (`connections/<label>.json`). */
export interface ConnectionDoc {
  /** The id: a restored connection keeps it, so references to it stay valid. */
  id?: string
  label: string
  /** The connector (definition) id. */
  connector: string
  scope: string
  /** Agent scope: the slug of the agent. */
  agent?: string | null
  enabled: boolean
  defaultEnabled: boolean
  /** The settings without secret fields. */
  settings: Record<string, unknown>
  /** The other stored fields of the connection (status, modes, choices, slug, created time), never secrets. */
  profile?: Record<string, unknown>
  usedBy?: Record<string, unknown>
  secrets?: string
}

export interface PersonDoc {
  id: string
  displayName: string
  nickname: string | null
  status: string
  role: string | null
  divisions: string[]
  fields: Record<string, string>
  notes: string
  memberId: string | null
  accounts: Array<{ platform: string; nativeId: string; label: string | null }>
}

export interface SettingsDoc {
  settings: Record<string, unknown>
  digest: Record<string, unknown>
}

// --- persona as Markdown -----------------------------------------------------------------------

export interface PersonaDoc {
  identity: { displayName: string; about: string; language: string; emoji: boolean }
  voice: string
  operatingRules: string
}

const IDENTITY_MARK = '<!-- identity '
const VOICE_MARK = '<!-- voice -->'
const RULES_MARK = '<!-- operating-rules -->'

/** The persona as a Markdown file a person can read and edit. */
export function personaMarkdown(p: PersonaDoc): string {
  const title =
    p.identity.displayName.trim() === '' ? 'Persona' : `Persona of ${p.identity.displayName}`
  return [
    `# ${title.replace(/\n/g, ' ')}`,
    '',
    `${IDENTITY_MARK}${JSON.stringify(p.identity).replaceAll('>', '\\u003e')} -->`,
    '',
    `About: ${p.identity.about}`,
    '',
    VOICE_MARK,
    '',
    p.voice,
    '',
    RULES_MARK,
    '',
    p.operatingRules,
    '',
  ].join('\n')
}

/** Reads {@link personaMarkdown} back; undefined when the file is not in that shape. */
export function parsePersonaMarkdown(text: string): PersonaDoc | undefined {
  const idLine = text.split('\n').find((l) => l.startsWith(IDENTITY_MARK))
  const v = text.indexOf(`\n${VOICE_MARK}\n`)
  const r = text.lastIndexOf(`\n${RULES_MARK}\n`)
  if (idLine === undefined || v < 0 || r < v) return undefined
  let identity: unknown
  try {
    identity = JSON.parse(idLine.slice(IDENTITY_MARK.length).replace(/ -->$/, ''))
  } catch {
    return undefined
  }
  const o = (identity ?? {}) as Record<string, unknown>
  if (
    typeof o.displayName !== 'string' ||
    typeof o.about !== 'string' ||
    typeof o.language !== 'string' ||
    typeof o.emoji !== 'boolean'
  ) {
    return undefined
  }
  const body = (from: number, to: number, mark: string): string => {
    const s = text.slice(from + mark.length + 2, to === -1 ? undefined : to)
    // one blank line after the marker and one before the next belong to the format
    return s.replace(/^\n/, '').replace(/\n$/, '')
  }
  return {
    identity: { displayName: o.displayName, about: o.about, language: o.language, emoji: o.emoji },
    voice: body(v, r, VOICE_MARK),
    operatingRules: body(r, -1, RULES_MARK),
  }
}

// --- secrets -----------------------------------------------------------------------------------

const isSecretMark = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && 'set' in (v as object)

/**
 * The settings of a connection for the export: a secret field (shown as `{ set, hint }`) is
 * dropped, a URL loses its query and credentials. Nothing sealed ever reaches the zip.
 */
export function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (isSecretMark(v)) continue
    if (/secret|token|password|api[-_]?key|credential|authorization/i.test(k)) continue
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      try {
        const u = new URL(v)
        u.username = ''
        u.password = ''
        u.search = ''
        u.hash = ''
        out[k] = u.toString()
        continue
      } catch {
        continue
      }
    }
    if (v !== null && typeof v === 'object') {
      out[k] = Array.isArray(v) ? v : publicSettings(v as Record<string, unknown>)
      continue
    }
    out[k] = v
  }
  return out
}

// --- comparing ---------------------------------------------------------------------------------

type Kind = 'agent' | 'routine' | 'person' | 'program' | 'connection' | string

/**
 * The part of a document an import compares and applies. What is left out cannot be written by an
 * import (an agent's role, a person's accounts and web member) or is the key (a routine's id).
 */
export function comparable(kind: Kind, doc: unknown): unknown {
  if (doc === null || typeof doc !== 'object') return doc
  const d = { ...(doc as Record<string, unknown>) }
  if (kind === 'agent') {
    delete d.role
    delete d.id
  }
  if (kind === 'program') delete d.id
  if (kind === 'connection') {
    delete d.id
    delete d.usedBy
    delete d.secrets
    delete d.profile
  }
  if (kind === 'routine') delete d.id
  if (kind === 'person') {
    delete d.id
    delete d.memberId
    delete d.accounts
  }
  return JSON.parse(canonicalJson(d))
}

// --- authority ---------------------------------------------------------------------------------

const list = (label: string, items: readonly string[] | undefined): string[] =>
  items !== undefined && items.length > 0 ? [`${label}: ${items.join(', ')}`] : []

/** What an agent document grants, one readable line each (permission mode, tool rules, connectors). */
export function agentAuthority(doc: AgentDoc): string[] {
  const lines = [`permission mode: ${doc.permissionMode}`]
  lines.push(...list('always allowed tool rules', doc.rules.allow))
  lines.push(...list('tool rules that ask', doc.rules.ask))
  if (doc.toolAccess !== null) lines.push(`tool access: ${doc.toolAccess}`)
  for (const [key, choices] of Object.entries(doc.connectors).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const state = typeof choices.enabled === 'string' ? choices.enabled : 'inherit'
    if (state === 'off') continue
    const caps =
      choices.capabilities !== null && typeof choices.capabilities === 'object'
        ? Object.entries(choices.capabilities as Record<string, unknown>)
            .map(([c, m]) => `${c}=${typeof m === 'string' ? m : JSON.stringify(m)}`)
            .join(', ')
        : ''
    lines.push(`connector ${key}: ${state}${caps === '' ? '' : ` (${caps})`}`)
  }
  return lines
}

export function programAuthority(doc: ProgramDoc): string[] {
  return [
    ...list('program tools', doc.authority.tools),
    ...list('program connectors', doc.authority.connectors),
    ...list('program may read', doc.authority.read),
    ...list('program may write', doc.authority.write),
    ...(doc.trigger.kind === 'schedule' ? ['runs on a schedule without being asked'] : []),
  ]
}

export function routineAuthority(doc: RoutineDoc): string[] {
  return [`runs "${doc.name}" on a schedule (${JSON.stringify(doc.schedule)})`]
}

export function personAuthority(doc: PersonDoc): string[] {
  return doc.role === 'owner' || doc.role === 'admin' ? [`directory role: ${doc.role}`] : []
}

/** The lines of `after` that `before` does not already have (what a change newly grants). */
export const newLines = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((l) => !before.includes(l))
