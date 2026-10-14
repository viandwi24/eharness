/**
 * Role resolution and a data-driven tool policy. Pure: no I/O. A role comes from the directory
 * only; what somebody says in a chat, their username or a platform admin badge never grant one.
 *
 * @see docs/specs/30-identity.md#5-roles
 */
import type { Person } from './types.ts'

export type ToolRisk = 'read' | 'write' | 'external' | 'destructive'
export const TOOL_RISKS: readonly ToolRisk[] = ['read', 'write', 'external', 'destructive']

/** What a role may do: allowed risks, plus names (deny wins over allow and risks). */
export interface RolePolicy {
  risks?: readonly ToolRisk[]
  allow?: readonly string[]
  deny?: readonly string[]
}

/** Policy per role name; a missing role or field falls back to {@link DEFAULT_ROLE_POLICY}. */
export type RolePolicies = Record<string, RolePolicy>

/**
 * The default table. owner/admin: every risk. member: reads only (own writes are an app decision:
 * list the tool names in `allow`). guest: nothing. An unknown role gets the guest row.
 */
export const DEFAULT_ROLE_POLICY: Readonly<Record<string, Required<RolePolicy>>> = {
  owner: { risks: TOOL_RISKS, allow: [], deny: [] },
  admin: { risks: TOOL_RISKS, allow: [], deny: [] },
  member: { risks: ['read'], allow: [], deny: [] },
  guest: { risks: [], allow: [], deny: [] },
}

export interface RoleDecision {
  allowed: boolean
  /** Why not, written for the model to read and relay. */
  reason?: string
}

export function resolvePolicy(role: string, policy?: RolePolicies): Required<RolePolicy> {
  const base = DEFAULT_ROLE_POLICY[role] ?? DEFAULT_ROLE_POLICY.guest
  const own = policy?.[role]
  return {
    risks: own?.risks ?? base?.risks ?? [],
    allow: own?.allow ?? base?.allow ?? [],
    deny: own?.deny ?? base?.deny ?? [],
  }
}

/**
 * Decide a tool call by role and static risk (a missing or unknown risk counts as `write`).
 * `toolName` is optional; without it only risks are checked. Deny, then allow, then risk.
 */
export function decideByRisk(
  role: string,
  risk: string | undefined,
  policy?: RolePolicies,
  toolName?: string,
): RoleDecision {
  const p = resolvePolicy(role, policy)
  if (toolName !== undefined && p.deny.includes(toolName)) return refuse(role, risk, toolName)
  if (toolName !== undefined && p.allow.includes(toolName)) return { allowed: true }
  const effective: ToolRisk = (TOOL_RISKS as readonly string[]).includes(risk ?? '')
    ? (risk as ToolRisk)
    : 'write'
  return p.risks.includes(effective) ? { allowed: true } : refuse(role, risk, toolName)
}

function refuse(
  role: string,
  risk: string | undefined,
  toolName: string | undefined,
): RoleDecision {
  const what = toolName ?? 'this action'
  return {
    allowed: false,
    reason: `Not allowed: the person who asked has the role "${role}", and that role may not use ${what}${risk === undefined ? '' : ` (${risk})`}. Tell them in one plain sentence to ask someone with a higher role. Do not retry or look for another way around it.`,
  }
}

/**
 * The effective role: a suspended or left person is `guest`; a linked person's role (`null` =
 * `defaultRole`); no person = `legacyRole ?? defaultRole`.
 */
export function resolveRole(input: {
  person: Pick<Person, 'status' | 'role'> | undefined | null
  legacyRole?: string | undefined
  defaultRole: string
}): string {
  const { person } = input
  if (person === undefined || person === null) return input.legacyRole ?? input.defaultRole
  if (person.status !== 'active') return 'guest'
  return person.role ?? input.defaultRole
}
