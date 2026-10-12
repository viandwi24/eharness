/**
 * Roles of the people directory and what each role may do (docs/plans/P41-team-channels.md, phase
 * L6). Pure: no I/O. A role is the company's own word for a person (`owner`, `admin`, `member`,
 * `guest`) and comes from the directory only; what somebody says about themselves in a chat, their
 * username and the platform's admin badge never grant one.
 *
 * Authorization is code on the *current requester* of a turn: `decideTool` is a deterministic
 * function of (role, tool, risk), used by the `tool.approve` hook of the channels plugin. Deny wins:
 * a tool in the role's `deny` list is refused even when its risk or its `allow` list would let it
 * through.
 */
import { z } from 'zod'

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type Role = (typeof ROLES)[number]
export const RoleSchema: z.ZodType<Role> = z.enum(ROLES)

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 }
export const roleRank = (role: Role): number => RANK[role]
/** The lower of two roles (a turn that several people triggered runs with the least privilege). */
export const lowerRole = (a: Role, b: Role): Role => (RANK[a] <= RANK[b] ? a : b)
/** Owner and admin act for the team: approvals, other people's reminders, writes. */
export const isStaff = (role: Role): boolean => RANK[role] >= RANK.admin

export const TOOL_RISKS = ['read', 'write', 'external', 'destructive'] as const
export type ToolRisk = (typeof TOOL_RISKS)[number]

/** What a role may call: by risk, by name, and the names it may never call (deny wins). */
export const RolePolicySchema = z.object({
  risks: z.array(z.enum(TOOL_RISKS)).optional(),
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
})
export type RolePolicy = z.infer<typeof RolePolicySchema>

/** Overrides per role (a missing role or field keeps the default). */
export const RolePoliciesSchema = z
  .object({
    owner: RolePolicySchema.optional(),
    admin: RolePolicySchema.optional(),
    member: RolePolicySchema.optional(),
    guest: RolePolicySchema.optional(),
  })
  .default({})
export type RolePolicies = z.infer<typeof RolePoliciesSchema>

/** Tools every role has: finding a deferred tool changes nothing. */
export const ALWAYS_ALLOWED: readonly string[] = ['tool_search']

/** The tools of the layer-1 channel surface a member may use (reads are scoped to their divisions in code). */
export const MEMBER_TOOLS: readonly string[] = [
  'channel_status',
  'channel_describe',
  'channel_read',
  'list_topics',
  'member_lookup',
  'chat_history',
  'chat_recap',
  'reminder',
]

export const DEFAULT_ROLE_POLICY: Record<Role, Required<RolePolicy>> = {
  owner: { risks: [...TOOL_RISKS], allow: [], deny: [] },
  admin: { risks: [...TOOL_RISKS], allow: [], deny: [] },
  member: { risks: [], allow: [...MEMBER_TOOLS], deny: [] },
  guest: { risks: [], allow: ['channel_status'], deny: [] },
}

/** The policy of one role: the defaults with the connection's overrides on top, field by field. */
export function policyOf(role: Role, overrides?: RolePolicies): Required<RolePolicy> {
  const base = DEFAULT_ROLE_POLICY[role]
  const own = overrides?.[role]
  return {
    risks: own?.risks ?? base.risks,
    allow: own?.allow ?? base.allow,
    deny: own?.deny ?? base.deny,
  }
}

export interface ToolDecision {
  allowed: boolean
  /** Why not, written for the model to read and relay. */
  reason?: string
}

/**
 * May a requester of `role` call `toolName` (static risk `risk`; a tool without one counts as a
 * write)? Deny list first, then the always-allowed set, the allow list and the allowed risks.
 */
export function decideTool(
  role: Role,
  toolName: string,
  risk: string | undefined,
  overrides?: RolePolicies,
  who?: string,
): ToolDecision {
  const policy = policyOf(role, overrides)
  const refuse = (): ToolDecision => ({
    allowed: false,
    reason: `Not allowed: ${who === undefined ? 'the person who asked' : who} has the role "${role}" in this team, and that role may not use ${toolName}${risk === undefined ? '' : ` (${risk})`}. ${
      role === 'guest'
        ? 'A guest only gets answers. '
        : role === 'member'
          ? 'Members can read the chats of their divisions and set their own reminders. '
          : ''
    }Only an owner or an admin can ask for this. Say so plainly; do not retry and do not look for another way around it.`,
  })
  if (policy.deny.includes(toolName)) return refuse()
  if (ALWAYS_ALLOWED.includes(toolName)) return { allowed: true }
  if (policy.allow.includes(toolName)) return { allowed: true }
  const effective = (TOOL_RISKS as readonly string[]).includes(risk ?? '')
    ? (risk as ToolRisk)
    : 'write'
  if (policy.risks.includes(effective)) return { allowed: true }
  return refuse()
}

/** The word for a role in the header and in refusals. */
export const roleLabel = (role: Role): string => role

/** Where a role came from (shown in the header and the People tab). */
export type RoleSource =
  | 'directory'
  | 'linked-admin'
  | 'linked-member'
  | 'anonymous'
  | 'bot'
  | 'default'

export interface RoleResolution {
  role: Role
  source: RoleSource
}

/**
 * The role of an identity. A chat that speaks as itself (an anonymous admin, a channel) and a bot
 * are guests whatever the directory says: nobody can tell who is behind them. Then the
 * directory entry; then the team member the identity is linked to (the connection's admins are
 * owners, any other linked member is a member); then the connection's default (guest).
 */
export function resolveRole(input: {
  kind: string
  isBot: boolean
  entryRole: Role | undefined
  linkedMember: string | undefined
  admins: readonly string[]
  defaultRole: Role
}): RoleResolution {
  if (input.kind === 'anonymous' || input.kind === 'channel')
    return { role: 'guest', source: 'anonymous' }
  if (input.isBot || input.kind === 'bot') return { role: 'guest', source: 'bot' }
  if (input.entryRole !== undefined) return { role: input.entryRole, source: 'directory' }
  if (input.linkedMember !== undefined) {
    return input.admins.includes(input.linkedMember)
      ? { role: 'owner', source: 'linked-admin' }
      : { role: 'member', source: 'linked-member' }
  }
  return { role: input.defaultRole, source: 'default' }
}
