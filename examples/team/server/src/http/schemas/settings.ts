import { z } from '@hono/zod-openapi'
import { PERMISSION_MODES } from '../../app/catalog.ts'

export const SettingsSchema = z
  .object({
    defaultPermissionMode: z.enum(PERMISSION_MODES).openapi({
      description:
        'The mode of every agent whose own `permissionMode` is `default`; read by the agent factory on every turn.',
    }),
    budgetUsd: z.number().positive().nullable().openapi({
      description: 'Monthly USD limit of the workspace budget ledger; null = tracked, not limited.',
    }),
    spawnCap: z.number().int().min(1).max(32).openapi({
      description: 'Children the lead runs at once (`subagents` `maxConcurrent`).',
    }),
    defaultModel: z.string().nullable().openapi({
      description: 'Model id of agents without their own; null = the server default.',
    }),
    updatedAt: z.number().int().openapi({ description: '0 until a person changed something.' }),
  })
  .openapi('Settings')

export const SettingsPatchSchema = z
  .object({
    defaultPermissionMode: z.enum(PERMISSION_MODES).optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    spawnCap: z.number().int().min(1).max(32).optional(),
    defaultModel: z.string().min(1).max(200).nullable().optional(),
  })
  .openapi('SettingsPatch')
