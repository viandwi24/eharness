/**
 * Persona versions and proposals (docs/plans/P42-team-persona.md) over plain SQL on the shared
 * connection. Versions are append-only; the unique index on (agent, version) makes two instances
 * that write at once settle: one wins, the other gets `undefined` and re-reads.
 */
import type { Database } from 'bun:sqlite'
import type { PersonaStore } from '../../app/ports.ts'
import type {
  PersonaIdentity,
  PersonaProposal,
  PersonaSource,
  PersonaVersion,
  ProposalStatus,
} from '../../domain/persona.ts'

interface VersionRow {
  id: string
  agent_id: string
  version: number
  identity: string
  voice: string
  operating_rules: string
  source: string
  author_name: string | null
  author_role: string | null
  author_ref: string | null
  reason: string | null
  diff: string
  revert_of: number | null
  proposal_id: string | null
  created_at: number
}

interface ProposalRow {
  id: string
  agent_id: string
  base_version: number
  identity: string
  voice: string
  reason: string
  request: string | null
  diff: string
  source: string
  proposer_name: string | null
  proposer_role: string | null
  proposer_ref: string | null
  session_id: string | null
  status: string
  decided_by: string | null
  decided_at: number | null
  applied_version: number | null
  created_at: number
}

const identityOf = (json: string): PersonaIdentity => {
  const raw = JSON.parse(json) as Partial<PersonaIdentity>
  return {
    displayName: raw.displayName ?? '',
    about: raw.about ?? '',
    language: raw.language ?? '',
    emoji: raw.emoji ?? true,
  }
}

const toVersion = (r: VersionRow): PersonaVersion => ({
  id: r.id,
  agentId: r.agent_id,
  version: r.version,
  identity: identityOf(r.identity),
  voice: r.voice,
  operatingRules: r.operating_rules,
  source: r.source as PersonaSource,
  authorName: r.author_name,
  authorRole: r.author_role,
  authorRef: r.author_ref,
  reason: r.reason,
  diff: r.diff,
  revertOf: r.revert_of,
  proposalId: r.proposal_id,
  createdAt: r.created_at,
})

const toProposal = (r: ProposalRow): PersonaProposal => ({
  id: r.id,
  agentId: r.agent_id,
  baseVersion: r.base_version,
  identity: identityOf(r.identity),
  voice: r.voice,
  reason: r.reason,
  request: r.request,
  diff: r.diff,
  source: r.source === 'web' ? 'web' : 'chat',
  proposerName: r.proposer_name,
  proposerRole: r.proposer_role,
  proposerRef: r.proposer_ref,
  sessionId: r.session_id,
  status: r.status as ProposalStatus,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  appliedVersion: r.applied_version,
  createdAt: r.created_at,
})

export function sqlitePersonaStore(sqlite: Database): PersonaStore {
  return {
    latest(agentId) {
      const r = sqlite
        .query<VersionRow, [string]>(
          'SELECT * FROM agent_persona_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1',
        )
        .get(agentId)
      return r === null ? undefined : toVersion(r)
    },
    latestNumber(agentId) {
      const r = sqlite
        .query<{ v: number | null }, [string]>(
          'SELECT MAX(version) AS v FROM agent_persona_versions WHERE agent_id = ?',
        )
        .get(agentId)
      return r?.v ?? 0
    },
    get(agentId, version) {
      const r = sqlite
        .query<VersionRow, [string, number]>(
          'SELECT * FROM agent_persona_versions WHERE agent_id = ? AND version = ?',
        )
        .get(agentId, version)
      return r === null ? undefined : toVersion(r)
    },
    history(agentId, limit = 100) {
      return sqlite
        .query<VersionRow, [string, number]>(
          'SELECT * FROM agent_persona_versions WHERE agent_id = ? ORDER BY version DESC LIMIT ?',
        )
        .all(agentId, limit)
        .map(toVersion)
    },
    append(v, after) {
      const version = after + 1
      try {
        sqlite
          .query(
            `INSERT INTO agent_persona_versions (id, agent_id, version, identity, voice, operating_rules,
               source, author_name, author_role, author_ref, reason, diff, revert_of, proposal_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            v.id,
            v.agentId,
            version,
            JSON.stringify(v.identity),
            v.voice,
            v.operatingRules,
            v.source,
            v.authorName,
            v.authorRole,
            v.authorRef,
            v.reason,
            v.diff,
            v.revertOf,
            v.proposalId,
            v.createdAt,
          )
      } catch (error) {
        if (String(error).includes('UNIQUE')) return undefined
        throw error
      }
      return { ...v, version }
    },
    insertProposal(p) {
      sqlite
        .query(
          `INSERT INTO agent_persona_proposals (id, agent_id, base_version, identity, voice, reason, request,
             diff, source, proposer_name, proposer_role, proposer_ref, session_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.id,
          p.agentId,
          p.baseVersion,
          JSON.stringify(p.identity),
          p.voice,
          p.reason,
          p.request,
          p.diff,
          p.source,
          p.proposerName,
          p.proposerRole,
          p.proposerRef,
          p.sessionId,
          p.status,
          p.createdAt,
        )
    },
    getProposal(id) {
      const r = sqlite
        .query<ProposalRow, [string]>('SELECT * FROM agent_persona_proposals WHERE id = ?')
        .get(id)
      return r === null ? undefined : toProposal(r)
    },
    listProposals(agentId, status) {
      const rows =
        status === undefined
          ? sqlite
              .query<ProposalRow, [string]>(
                'SELECT * FROM agent_persona_proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100',
              )
              .all(agentId)
          : sqlite
              .query<ProposalRow, [string, string]>(
                'SELECT * FROM agent_persona_proposals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100',
              )
              .all(agentId, status)
      return rows.map(toProposal)
    },
    decideProposal(id, change) {
      // only a pending proposal can be decided; two admins pressing at once decide it once
      const res = sqlite
        .query(
          `UPDATE agent_persona_proposals SET status = ?, decided_by = ?, decided_at = ?, applied_version = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(change.status, change.decidedBy, change.decidedAt, change.appliedVersion ?? null, id)
      return res.changes > 0
    },
    setAppliedVersion(id, version) {
      sqlite
        .query(
          "UPDATE agent_persona_proposals SET applied_version = ? WHERE id = ? AND status = 'applied'",
        )
        .run(version, id)
    },
    pendingCount(agentId) {
      const r = sqlite
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM agent_persona_proposals WHERE agent_id = ? AND status = 'pending'",
        )
        .get(agentId)
      return r?.n ?? 0
    },
  }
}
