import { z } from '@hono/zod-openapi'
import { AGENT_ROLES, PERMISSION_MODES, TOOL_ACCESS } from '../../app/catalog.ts'
import { ConnectionChoicesSchema } from './connectors.ts'
import { ActivitySchema } from './tasks.ts'

const Rules = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .openapi('PermissionRules', {
    description: 'Permission rules in `Tool(spec)` form (eharness/permissions).',
  })

export const AgentSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    slug: z.string().openapi({ example: 'researcher' }),
    name: z.string().openapi({ example: 'Researcher' }),
    role: z.enum(AGENT_ROLES),
    avatar: z.string().nullable(),
    color: z.string().openapi({ example: '#6366f1' }),
    description: z.string(),
    instructions: z.string(),
    model: z
      .string()
      .nullable()
      .openapi({ description: 'Model id; null = the workspace default model.' }),
    modelProfile: z.string().nullable().openapi({
      description:
        'Provider profile the model is reached through (with `model` it is the `{ profileId, modelId }` pick); null = the default profile.',
    }),
    toolAccess: z.enum(TOOL_ACCESS).nullable().openapi({
      description:
        'How the tools of third-party connectors reach the model: `auto` (up front until the agent has 20 or more, then found with `tool_search`) or `on-demand` (always found with `tool_search`); null = the workspace default (`GET /settings`). Built-in connectors are never deferred.',
    }),
    connectors: z.record(z.string(), ConnectionChoicesSchema).openapi({
      description:
        "This agent's own choices per connection id (on / off / inherit, capability modes). Use `GET /agents/{id}/connectors` for the effective view.",
    }),
    skills: z.array(z.string()),
    permissionMode: z.enum(PERMISSION_MODES),
    rules: Rules,
    version: z.number().int().openapi({ description: 'Bumps on every edit.' }),
    archivedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('Agent')

export const AgentCreateSchema = z
  .object({
    slug: z.string().optional().openapi({
      description: 'Lowercase letters, digits and dashes; derived from the name when absent.',
    }),
    name: z.string().min(1).max(80),
    role: z
      .enum(['role', 'custom'])
      .optional()
      .openapi({ description: 'Default `custom`. The lead exists from the seed.' }),
    avatar: z.string().nullable().optional(),
    color: z.string().optional(),
    description: z.string().max(280).optional(),
    instructions: z.string().min(1),
    model: z.string().nullable().optional().openapi({
      description:
        'Model id. A legacy `profile:model` string is split when the prefix names a profile; a plain id follows `modelProfile`, else the default profile.',
    }),
    modelProfile: z.string().nullable().optional().openapi({
      description: 'Provider profile id from `GET /providers`; null = the default profile.',
    }),
    connectors: z.record(z.string(), ConnectionChoicesSchema).optional().openapi({
      description:
        'Replaces the whole enablement. Default for a new agent: Files (read only), Memory and Planning. Prefer `PUT /agents/{id}/connectors`.',
    }),
    toolAccess: z.enum(TOOL_ACCESS).nullable().optional().openapi({
      description: 'See `Agent.toolAccess`; null = the workspace default.',
    }),
    skills: z.array(z.string()).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    rules: Rules.partial().optional(),
  })
  .openapi('AgentCreate')

export const AgentPatchSchema = AgentCreateSchema.omit({ slug: true, role: true })
  .partial()
  .openapi('AgentPatch', { description: 'Only the given fields change; `version` bumps.' })

export const AgentListItemSchema = AgentSchema.extend({
  lastActivity: ActivitySchema.openapi({
    description: 'Sidebar data: last message time, its preview and the unread count.',
  }),
}).openapi('AgentListItem')

export const AgentListSchema = z
  .object({ agents: z.array(AgentListItemSchema) })
  .openapi('AgentList')
