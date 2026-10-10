import { z } from '@hono/zod-openapi'
import { AGENT_ROLES, PERMISSION_MODES, TOOL_CATALOG, TOOL_NAMES } from '../../app/catalog.ts'

const Rules = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .openapi('PermissionRules', {
    description: 'Permission rules in `Tool(spec)` form (eharness/permissions).',
  })

const ToolName = z.enum(TOOL_NAMES as unknown as [string, ...string[]]).openapi('ToolName')

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
      .openapi({ description: 'Model id; null = the workspace default.' }),
    tools: z.array(ToolName),
    skills: z.array(z.string()),
    mcp: z.array(z.string()),
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
    model: z.string().nullable().optional(),
    tools: z.array(ToolName).optional(),
    skills: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    rules: Rules.partial().optional(),
  })
  .openapi('AgentCreate')

export const AgentPatchSchema = AgentCreateSchema.omit({ slug: true, role: true })
  .partial()
  .openapi('AgentPatch', { description: 'Only the given fields change; `version` bumps.' })

export const AgentListSchema = z.object({ agents: z.array(AgentSchema) }).openapi('AgentList')

export const ToolCatalogSchema = z
  .object({
    tools: z.array(z.object({ name: ToolName, description: z.string() })),
  })
  .openapi('ToolCatalog')

export const TOOL_CATALOG_VALUE = { tools: TOOL_CATALOG.map((t) => ({ ...t })) }
