import { z } from '@hono/zod-openapi'
import { PERMISSION_MODES, SETTINGS_MODES, TOOL_ACCESS } from '../../app/catalog.ts'

export const SettingsSchema = z
  .object({
    defaultPermissionMode: z.enum(SETTINGS_MODES).openapi({
      description:
        'The workspace default permission mode: `default` = Manual, `auto` = Auto (classifier), `bypassPermissions` = Bypass. The mode of every chat and agent that has none of its own; read on every tool call.',
    }),
    toolAccess: z.enum(TOOL_ACCESS).openapi({
      description:
        'Tool access of agents without their own setting: `auto` or `on-demand` (third-party connector tools found with `tool_search`).',
    }),
    budgetUsd: z.number().positive().nullable().openapi({
      description: 'Monthly USD limit of the workspace budget ledger; null = tracked, not limited.',
    }),
    spawnCap: z.number().int().min(1).max(32).openapi({
      description: 'Children the lead runs at once (`subagents` `maxConcurrent`).',
    }),
    defaultModel: z.string().nullable().openapi({
      description:
        'Model id of agents without their own; null = the default model of the default profile.',
    }),
    defaultProfile: z.string().nullable().openapi({
      description:
        'Provider profile of agents without their own pick; null = the server default (the env profile, else the first enabled one).',
    }),
    timezone: z.string().openapi({
      description:
        'IANA timezone of the team (default: the `TZ` variable or the host timezone). The default of the heartbeat active hours and of the daily digest time; an agent heartbeat or the digest can override it.',
    }),
    updatedAt: z.number().int().openapi({ description: '0 until a person changed something.' }),
  })
  .openapi('Settings')

export const SettingsPatchSchema = z
  .object({
    defaultPermissionMode: z.enum(PERMISSION_MODES).optional().openapi({
      description:
        'Legacy values (`acceptEdits`, `plan`, `dontAsk`, `manual`) are stored as `default` (Manual).',
    }),
    toolAccess: z.enum(TOOL_ACCESS).optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    spawnCap: z.number().int().min(1).max(32).optional(),
    defaultModel: z.string().min(1).max(200).nullable().optional().openapi({
      description:
        'A model id, or the legacy `profile:model` (split when the prefix names a profile).',
    }),
    defaultProfile: z.string().min(1).max(64).nullable().optional(),
    timezone: z.string().min(1).max(64).optional().openapi({ description: 'IANA timezone.' }),
  })
  .openapi('SettingsPatch')
