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
    stuckRunMinutes: z.number().int().min(5).max(1440).openapi({
      description:
        'A program, routine or queued run with no activity for this many minutes is stopped through the Stop path and raises an alarm (Health, Needs attention). It is never run again by itself. Default 45.',
    }),
    classifierModel: z.string().nullable().openapi({
      description:
        'Model of the Auto mode classifier. null = "Same as the agent": the model of the agent whose action is judged. The initial value is `TEAM_CLASSIFIER_MODEL` when set.',
    }),
    classifierProfile: z.string().nullable().openapi({
      description: 'Provider profile of `classifierModel`; null = the workspace default profile.',
    }),
    searchModel: z.string().nullable().openapi({
      description:
        'Model of `web_search`. null = the built-in small model of the provider. The initial value is `TEAM_SEARCH_MODEL` when set.',
    }),
    searchProfile: z.string().nullable().openapi({
      description:
        'Provider profile of `searchModel` (an OpenRouter or AI Gateway profile); null = the workspace default profile, else the first that can search.',
    }),
    contextCap: z.number().int().min(16000).nullable().openapi({
      description:
        'Deprecated ceiling on every agent context window (tokens). null = none: the window follows each agent model. Initial value: `TEAM_CONTEXT_CAP`.',
    }),
    heartbeatContextWindow: z.number().int().min(16000).openapi({
      description:
        'The working context window (tokens) of every heartbeat session, independent of the chat window of the agent and clamped to its model window. History is summarized early so each beat starts small. Default 64000.',
    }),
    connectorHealthTtlMs: z.number().int().min(0).max(86400000).nullable().openapi({
      description:
        'A custom connector is re-checked in the background when its last check is older than this (ms); 0 = on every listing; null = never. Default 60000.',
    }),
    connectorProbeRetryMs: z.number().int().min(0).max(60000).openapi({
      description:
        'A failed check of a connected server is retried once after this long (ms) before the connection counts as down. Default 3000.',
    }),
    longRunMaxCostUsd: z.number().min(0).openapi({
      description:
        'A background worker job stops at this estimated cost (USD); 0 = no limit. Default 10.',
    }),
    longRunMaxHours: z.number().min(0).openapi({
      description:
        'A background worker job stops this many hours after it started; 0 = no limit. Default 24.',
    }),
    longRunChunkSteps: z.number().int().min(10).max(500).openapi({
      description: 'Steps per chunk of a background worker job. Default 80.',
    }),
    maxRepeatingReminders: z.number().int().min(0).max(1000).openapi({
      description: 'Most active repeating reminders one person may have; 0 = no limit. Default 10.',
    }),
    teamName: z.string().nullable().openapi({
      description:
        'The team name given to agents in chats; null = none. Initial value: `TEAM_NAME`.',
    }),
    eventsRetentionHours: z.number().int().min(0).openapi({
      description: 'Events feed: hours kept; 0 = by count only. Default 72.',
    }),
    eventsMaxRows: z.number().int().min(1000).openapi({
      description: 'Events feed: rows kept. Default 100000.',
    }),
    logMaxRows: z.number().int().min(100).openapi({
      description: 'Model call log (Logs page): rows kept. Default 5000.',
    }),
    logRetentionDays: z.number().min(1).openapi({
      description: 'Model call log: days kept. Default 7.',
    }),
    mediaRetentionDays: z.number().int().min(0).openapi({
      description: 'Tool media and browser screenshots kept this many days; 0 = keep. Default 3.',
    }),
    routineRunsRetentionDays: z.number().int().min(0).openapi({
      description: 'Finished routine runs kept this many days; 0 = keep. Default 30.',
    }),
    tasksRetentionDays: z.number().int().min(0).openapi({
      description: 'Finished tasks kept this many days; 0 = keep. Default 90.',
    }),
    libraryHistoryRetentionDays: z.number().int().min(0).openapi({
      description: 'Library history kept this many days; 0 = keep. Default 180.',
    }),
    backupEnabled: z.boolean().openapi({
      description:
        'Automatic backups: a snapshot every day at `backupTime` and one at start-up when none was taken today. Default on. Manual and before-risky-operation snapshots always work.',
    }),
    backupTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .openapi({
        description: 'Local time (team timezone) of the daily snapshot, HH:MM. Default 02:00.',
      }),
    backupKeepDaily: z.number().int().min(1).max(365).openapi({
      description: 'The newest snapshot of each of this many days is kept. Default 14.',
    }),
    backupKeepWeekly: z.number().int().min(0).max(520).openapi({
      description: 'The newest snapshot of each of this many weeks is kept. Default 8.',
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
    stuckRunMinutes: z.number().int().min(5).max(1440).optional(),
    classifierModel: z.string().min(1).max(200).nullable().optional(),
    classifierProfile: z.string().min(1).max(64).nullable().optional(),
    searchModel: z.string().min(1).max(200).nullable().optional(),
    searchProfile: z.string().min(1).max(64).nullable().optional(),
    contextCap: z.number().int().min(16000).nullable().optional(),
    heartbeatContextWindow: z.number().int().min(16000).max(10000000).optional(),
    connectorHealthTtlMs: z.number().int().min(0).max(86400000).nullable().optional(),
    connectorProbeRetryMs: z.number().int().min(0).max(60000).optional(),
    longRunMaxCostUsd: z.number().min(0).max(100000).optional(),
    longRunMaxHours: z.number().min(0).max(8760).optional(),
    longRunChunkSteps: z.number().int().min(10).max(500).optional(),
    maxRepeatingReminders: z.number().int().min(0).max(1000).optional(),
    teamName: z.string().min(1).max(100).nullable().optional(),
    eventsRetentionHours: z.number().int().min(0).max(87600).optional(),
    eventsMaxRows: z.number().int().min(1000).optional(),
    logMaxRows: z.number().int().min(100).optional(),
    logRetentionDays: z.number().min(1).max(3650).optional(),
    mediaRetentionDays: z.number().int().min(0).max(36500).optional(),
    routineRunsRetentionDays: z.number().int().min(0).max(36500).optional(),
    tasksRetentionDays: z.number().int().min(0).max(36500).optional(),
    libraryHistoryRetentionDays: z.number().int().min(0).max(36500).optional(),
    backupEnabled: z.boolean().optional(),
    backupTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    backupKeepDaily: z.number().int().min(1).max(365).optional(),
    backupKeepWeekly: z.number().int().min(0).max(520).optional(),
  })
  .openapi('SettingsPatch')

export const CodeSandboxSchema = z
  .object({
    driver: z.enum(['off', 'local']).openapi({
      description: '`TEAM_CODE_DRIVER`: where agents run Python (`run_python`).',
    }),
    python: z.string().nullable().openapi({
      description: 'Python version of the interpreter; null when off, unknown or inside docker.',
    }),
    isolated: z.boolean().openapi({
      description:
        'True when the code runs under an OS sandbox or in a container, without network.',
    }),
    install: z.enum(['off', 'allowlist', 'any']).openapi({ description: '`TEAM_CODE_INSTALL`.' }),
    label: z.string().openapi({ description: 'One line for people.' }),
    remote: z
      .object({
        host: z.string(),
        python: z.string().nullable(),
        isolated: z.boolean(),
        label: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          'The Remote sandbox connector when one is connected (host of its URL, never the token); null when it is not reachable.',
      }),
  })
  .openapi('CodeSandbox')

const ModelSourceSchema = z.enum(['setting', 'env', 'built-in', 'agent']).openapi({
  description:
    '`setting`: picked in Settings or on the agent; `env`: from `TEAM_MODEL`; `built-in`: the provider fallback nobody chose; `agent`: follows the model of each agent.',
})

export const SettingsModelsSchema = z
  .object({
    workspaceDefault: z
      .object({
        profileId: z.string(),
        profileLabel: z.string(),
        modelId: z.string(),
        source: z.enum(['setting', 'env', 'built-in']),
      })
      .nullable()
      .openapi({
        description:
          'What an agent without a model of its own runs on; null when no provider is configured.',
      }),
    background: z.array(
      z.object({
        key: z.enum(['classifier', 'search', 'compaction', 'heartbeat', 'programs']),
        label: z.string(),
        profileId: z.string().nullable(),
        profileLabel: z.string().nullable(),
        modelId: z
          .string()
          .nullable()
          .openapi({ description: 'null: follows the model of each agent.' }),
        source: ModelSourceSchema,
        note: z.string(),
      }),
    ),
    agentsOnFallback: z.array(z.string()).openapi({
      description: 'Names of agents that run on a built-in fallback model because none was picked.',
    }),
    warnings: z.array(z.string()),
  })
  .openapi('SettingsModels')
