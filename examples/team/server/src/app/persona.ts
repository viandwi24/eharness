/**
 * Persona use cases (docs/plans/P42-team-persona.md): read the current persona, edit it from the web,
 * propose a change, apply or reject a proposal, revert to an earlier version. Every change is a new
 * version with its author, source and diff; nothing is edited in place.
 *
 * Who may do what is decided here, in code, from the actor and never from what a message says:
 * the web (a token holder) is an admin; in a chat only the directory roles `owner` and `admin` apply
 * and revert; anybody who may use the tool may propose.
 */
import type { AgentDef } from '../domain/agents.ts'
import { conflict, DomainError, invalid, notFound } from '../domain/errors.ts'
import {
  assertValidContent,
  checkOperatingRules,
  MAX_REASON,
  normalizeIdentity,
  type PersonaContent,
  type PersonaIdentity,
  type PersonaProposal,
  type PersonaSnapshot,
  type PersonaSource,
  type PersonaVersion,
  personaDiff,
  personaFromLegacy,
  sameContent,
} from '../domain/persona.ts'
import type { Deps } from './ports.ts'

/** Who makes a change: a web user (token holder) or a person in a chat (with their directory role). */
export interface PersonaActor {
  kind: 'web' | 'chat'
  name: string
  /** Directory role in a chat (`owner`, `admin`, `member`, `guest`). */
  role?: string | undefined
  /** Platform identity id in a chat. */
  ref?: string | undefined
}

export const WEB_ACTOR: PersonaActor = { kind: 'web', name: 'the web app' }

/** Owner and admin of the directory, and the web (token holders), may apply and revert. */
export const isPersonaAdmin = (actor: PersonaActor): boolean =>
  actor.kind === 'web' || actor.role === 'owner' || actor.role === 'admin'

function requireAdmin(actor: PersonaActor): void {
  if (!isPersonaAdmin(actor)) {
    throw new DomainError(
      'forbidden',
      'PERSONA_ADMIN_ONLY',
      'Only an owner or an admin can apply or revert a persona change.',
    )
  }
}

function getAgent(deps: Deps, ref: string): AgentDef {
  const def = deps.agents.get(ref) ?? deps.agents.getBySlug(ref)
  if (def === undefined) throw notFound('agent', ref)
  return def
}

const snapshotOf = (v: PersonaVersion): PersonaSnapshot => ({
  identity: v.identity,
  voice: v.voice,
  operatingRules: v.operatingRules,
})

/** Append a version, retrying when another instance took the number (re-reads and re-diffs). */
function commit(
  deps: Deps,
  agentId: string,
  next: (current: PersonaVersion | undefined) => PersonaSnapshot,
  meta: {
    source: PersonaSource
    actor: PersonaActor | undefined
    reason: string | null
    revertOf?: number
    proposalId?: string
  },
): PersonaVersion {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = deps.persona.latest(agentId)
    const snapshot = next(current)
    const written = deps.persona.append(
      {
        id: deps.ids.next(),
        agentId,
        ...snapshot,
        source: meta.source,
        authorName: meta.actor?.name ?? null,
        authorRole: meta.actor?.role ?? null,
        authorRef: meta.actor?.ref ?? null,
        reason: meta.reason,
        diff: current === undefined ? '' : personaDiff(snapshotOf(current), snapshot),
        revertOf: meta.revertOf ?? null,
        proposalId: meta.proposalId ?? null,
        createdAt: deps.clock.now(),
      },
      current?.version ?? 0,
    )
    if (written !== undefined) {
      // the first version of an agent (boot, creation) is not news; every later one is
      if (meta.source !== 'migration') {
        deps.events.append({
          type: 'agent-changed',
          agentId,
          payload: { persona: written.version, source: meta.source },
        })
      }
      return written
    }
  }
  throw conflict('the persona was changed concurrently; reload and retry', 'VERSION_CONFLICT')
}

/**
 * The first persona of an agent, made from its name, description and old instructions (see
 * `splitLegacyInstructions`). Idempotent: nothing happens when the agent has a version already.
 */
export function ensurePersona(deps: Deps, agent: AgentDef): PersonaVersion {
  const have = deps.persona.latest(agent.id)
  if (have !== undefined) return have
  return commit(deps, agent.id, () => personaFromLegacy(agent), {
    source: 'migration',
    actor: undefined,
    reason: 'Made from the instructions the agent had before personas',
  })
}

/** Every agent gets a persona (boot): returns how many were made. Safe to run on every start. */
export function ensureAllPersonas(deps: Deps): number {
  let made = 0
  for (const agent of deps.agents.list({ includeArchived: true })) {
    if (deps.persona.latestNumber(agent.id) === 0) {
      ensurePersona(deps, agent)
      made++
    }
  }
  return made
}

/** The agent's old `instructions` field was edited (API compatibility): map it into a new version. */
export function personaFromInstructions(deps: Deps, agent: AgentDef): PersonaVersion {
  const mapped = personaFromLegacy(agent)
  return commit(
    deps,
    agent.id,
    (current) => ({
      identity: current?.identity ?? mapped.identity,
      voice: mapped.voice,
      operatingRules: mapped.operatingRules,
    }),
    { source: 'web', actor: WEB_ACTOR, reason: 'Instructions edited' },
  )
}

export interface PersonaState {
  agentId: string
  current: PersonaVersion
  pending: PersonaProposal[]
}

export function getPersonaState(deps: Deps, ref: string): PersonaState {
  const agent = getAgent(deps, ref)
  const current = ensurePersona(deps, agent)
  return {
    agentId: agent.id,
    current,
    pending: deps.persona.listProposals(agent.id, 'pending'),
  }
}

export function personaHistory(deps: Deps, ref: string): PersonaVersion[] {
  const agent = getAgent(deps, ref)
  ensurePersona(deps, agent)
  return deps.persona.history(agent.id)
}

export interface PersonaEdit {
  identity?: Partial<PersonaIdentity> | undefined
  voice?: string | undefined
  operatingRules?: string | undefined
  reason?: string | undefined
}

/** A direct edit from the web: a token holder is an admin, so it is a new version, not a proposal. */
export function editPersona(deps: Deps, ref: string, edit: PersonaEdit): PersonaVersion {
  const agent = getAgent(deps, ref)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'ARCHIVED')
  const current = ensurePersona(deps, agent)
  const identity = normalizeIdentity(current.identity, edit.identity ?? {})
  const voice = edit.voice ?? current.voice
  const operatingRules = edit.operatingRules ?? current.operatingRules
  const content: PersonaContent = { identity, voice }
  // only what the edit changes is checked: a migrated persona may be longer than a new one can be
  if (!sameContent(content, current)) assertValidContent(content)
  if (operatingRules !== current.operatingRules) {
    const problem = checkOperatingRules(operatingRules)
    if (problem !== undefined) throw invalid(problem, 'PERSONA_INVALID')
  }
  const next: PersonaSnapshot = { identity, voice, operatingRules }
  if (personaDiff(snapshotOf(current), next) === '') return current
  const reason = (edit.reason ?? '').trim().slice(0, MAX_REASON)
  return commit(deps, agent.id, () => next, {
    source: 'web',
    actor: WEB_ACTOR,
    reason: reason === '' ? null : reason,
  })
}

export interface ProposalInput {
  identity?: Partial<PersonaIdentity> | undefined
  voice?: string | undefined
  reason: string
  request?: string | undefined
}

/**
 * Open a proposal: a diff and a reason with the proposer's identity. It changes nothing until an
 * admin applies it. A proposal that changes nothing, or that repeats a pending one, is not stored.
 */
export function proposePersona(
  deps: Deps,
  ref: string,
  input: ProposalInput,
  actor: PersonaActor,
  sessionId?: string,
): { proposal: PersonaProposal; duplicate: boolean } {
  const agent = getAgent(deps, ref)
  const current = ensurePersona(deps, agent)
  const content: PersonaContent = {
    identity: normalizeIdentity(current.identity, input.identity ?? {}),
    voice: input.voice ?? current.voice,
  }
  if (sameContent(content, current)) throw invalid('That is what the persona already says.')
  assertValidContent(content)
  const reason = input.reason.trim()
  if (reason === '') throw invalid('A proposal needs a reason.')
  const duplicate = deps.persona
    .listProposals(agent.id, 'pending')
    .find((p) => p.baseVersion === current.version && sameContent(p, content))
  if (duplicate !== undefined) return { proposal: duplicate, duplicate: true }
  const proposal: PersonaProposal = {
    id: deps.ids.next(),
    agentId: agent.id,
    baseVersion: current.version,
    ...content,
    reason: reason.slice(0, MAX_REASON),
    request: input.request?.trim().slice(0, 500) ?? null,
    diff: personaDiff(snapshotOf(current), { ...content, operatingRules: current.operatingRules }),
    source: actor.kind,
    proposerName: actor.name,
    proposerRole: actor.role ?? null,
    proposerRef: actor.ref ?? null,
    sessionId: sessionId ?? null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    appliedVersion: null,
    createdAt: deps.clock.now(),
  }
  deps.persona.insertProposal(proposal)
  deps.events.append({
    type: 'agent-changed',
    agentId: agent.id,
    payload: { personaProposal: proposal.id },
  })
  return { proposal, duplicate: false }
}

function proposalOf(deps: Deps, id: string): PersonaProposal {
  const p = deps.persona.getProposal(id)
  if (p === undefined) throw notFound('persona proposal', id)
  return p
}

/**
 * Apply a pending proposal as a new version. Checks, in code: the actor is an admin, the proposal
 * is pending, and the identity and voice are still what it was written against (otherwise it is
 * `stale`: the person who looks at it sees an old diff).
 */
export function applyProposal(
  deps: Deps,
  id: string,
  actor: PersonaActor,
): { version: PersonaVersion; proposal: PersonaProposal } {
  requireAdmin(actor)
  const proposal = proposalOf(deps, id)
  if (proposal.status !== 'pending') {
    throw conflict(`That proposal is already ${proposal.status}.`, 'PROPOSAL_DECIDED')
  }
  const current = deps.persona.latest(proposal.agentId)
  const base = deps.persona.get(proposal.agentId, proposal.baseVersion)
  if (current === undefined || base === undefined || !sameContent(current, base)) {
    deps.persona.decideProposal(id, {
      status: 'stale',
      decidedBy: actor.name,
      decidedAt: deps.clock.now(),
    })
    throw conflict(
      'The persona changed after this was proposed. Ask for a new proposal.',
      'PROPOSAL_STALE',
    )
  }
  assertValidContent(proposal)
  // the version is committed first: a failed commit (a version conflict) throws and leaves the
  // proposal pending, so it can be applied again; it is marked applied only once the version exists
  const version = commit(
    deps,
    proposal.agentId,
    (c) => ({
      identity: proposal.identity,
      voice: proposal.voice,
      operatingRules: c?.operatingRules ?? '',
    }),
    { source: actor.kind, actor, reason: proposal.reason, proposalId: proposal.id },
  )
  if (
    !deps.persona.decideProposal(id, {
      status: 'applied',
      decidedBy: actor.name,
      decidedAt: deps.clock.now(),
    })
  ) {
    throw conflict('That proposal was decided just now.', 'PROPOSAL_DECIDED')
  }
  deps.persona.setAppliedVersion(id, version.version)
  return { version, proposal: { ...proposal, status: 'applied', appliedVersion: version.version } }
}

export function rejectProposal(deps: Deps, id: string, actor: PersonaActor): PersonaProposal {
  requireAdmin(actor)
  const proposal = proposalOf(deps, id)
  if (
    !deps.persona.decideProposal(id, {
      status: 'rejected',
      decidedBy: actor.name,
      decidedAt: deps.clock.now(),
    })
  ) {
    throw conflict(`That proposal is already ${proposal.status}.`, 'PROPOSAL_DECIDED')
  }
  deps.events.append({
    type: 'agent-changed',
    agentId: proposal.agentId,
    payload: { personaProposal: proposal.id },
  })
  return proposalOf(deps, id)
}

/**
 * Restore the identity and voice of an earlier version as a new version (the history keeps
 * everything). The operating rules stay as they are: they are edited in the web only.
 */
export function revertPersona(
  deps: Deps,
  ref: string,
  toVersion: number,
  actor: PersonaActor,
): PersonaVersion {
  requireAdmin(actor)
  const agent = getAgent(deps, ref)
  const current = ensurePersona(deps, agent)
  const target = deps.persona.get(agent.id, toVersion)
  if (target === undefined) throw notFound('persona version', String(toVersion))
  if (sameContent(target, current))
    throw invalid(`The persona already says what version ${toVersion} said.`)
  return commit(
    deps,
    agent.id,
    (c) => ({
      identity: target.identity,
      voice: target.voice,
      operatingRules: c?.operatingRules ?? '',
    }),
    { source: 'revert', actor, reason: `Reverted to version ${toVersion}`, revertOf: toVersion },
  )
}

/** The line every chat and the web shows after a change: who, what and from when. */
export function noticeOf(version: PersonaVersion, agentName: string): string {
  const by = version.authorName ?? 'the team'
  const what =
    version.source === 'revert'
      ? `reverted to version ${version.revertOf}`
      : (version.reason ?? 'changed')
  return `Persona of ${agentName} updated by ${by}: ${what} (version ${version.version}, effective from the next message).`
}
