import { describe, expect, test } from 'bun:test'
import {
  ALWAYS_ALLOWED,
  DEFAULT_ROLE_POLICY,
  decideTool,
  MEMBER_TOOLS,
  ROLES,
  type Role,
  type RolePolicies,
  TOOL_RISKS,
} from '../src/infra/channels/roles.ts'

/** The team's tool decision as it was before it moved onto `decideByRisk` (frozen reference). */
function referenceDecide(
  role: Role,
  toolName: string,
  risk: string | undefined,
  overrides?: RolePolicies,
  who?: string,
): { allowed: boolean; reason?: string } {
  const base = DEFAULT_ROLE_POLICY[role]
  const own = overrides?.[role]
  const policy = {
    risks: own?.risks ?? base.risks,
    allow: own?.allow ?? base.allow,
    deny: own?.deny ?? base.deny,
  }
  const refuse = (): { allowed: boolean; reason?: string } => ({
    allowed: false,
    reason: `Not allowed: ${who === undefined ? 'the person who asked' : who} has the role "${role}" in this team, and that role may not use ${toolName}${risk === undefined ? '' : ` (${risk})`}. ${
      role === 'guest'
        ? 'A guest only gets answers. '
        : role === 'member'
          ? 'Members can read the chats of their divisions and set their own reminders. '
          : ''
    }Only an owner or an admin can ask for this: tell the person, in one plain sentence, to ask an admin. Do not explain where or how roles are set, do not retry and do not look for another way around it. Never offer an action you cannot do (for example "I will note it" or "I will pass it on"): offer only what a tool of yours really does.`,
  })
  if (policy.deny.includes(toolName)) return refuse()
  if (ALWAYS_ALLOWED.includes(toolName)) return { allowed: true }
  if (policy.allow.includes(toolName)) return { allowed: true }
  const effective = (TOOL_RISKS as readonly string[]).includes(risk ?? '') ? risk : 'write'
  if (policy.risks.includes(effective as never)) return { allowed: true }
  return refuse()
}

const TOOLS = [
  ...MEMBER_TOOLS,
  'tool_search',
  'channel_status',
  'channel_send',
  'channel_manage',
  'write_file',
  'web_search',
  'decision',
]
const RISKS: Array<string | undefined> = [...TOOL_RISKS, undefined, 'weird', '']
const OVERRIDES: Array<RolePolicies | undefined> = [
  undefined,
  {},
  { member: { risks: ['read', 'write'] } },
  { member: { deny: ['reminder', 'tool_search'] } },
  { admin: { deny: ['channel_manage'] }, guest: { allow: ['web_search'], risks: ['read'] } },
  { owner: { risks: [] }, member: { allow: [] } },
  { guest: { deny: ['channel_status'] } },
]

describe('tool decisions on the library policy', () => {
  test('every role x tool x risk x override x who matches the previous decision', () => {
    let n = 0
    for (const role of ROLES)
      for (const tool of TOOLS)
        for (const risk of RISKS)
          for (const overrides of OVERRIDES)
            for (const who of [undefined, 'Budi']) {
              const got = decideTool(role, tool, risk, overrides, who)
              const want = referenceDecide(role, tool, risk, overrides, who)
              if (JSON.stringify(got) !== JSON.stringify(want))
                throw new Error(
                  `${role} ${tool} ${String(risk)} ${JSON.stringify(overrides)} ${String(who)}: ${JSON.stringify(got)} !== ${JSON.stringify(want)}`,
                )
              n++
            }
    expect(n).toBeGreaterThan(1000)
  })
})
