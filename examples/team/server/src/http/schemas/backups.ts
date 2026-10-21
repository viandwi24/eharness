import { z } from '@hono/zod-openapi'
import { BACKUP_KINDS, RESTORE_MODES } from '../../app/catalog.ts'

export const BackupSchema = z
  .object({
    id: z.string().openapi({ example: 'team-20261022T020000123Z-ab12' }),
    createdAt: z.number().int(),
    reason: z.string().openapi({
      description:
        '`daily`, `startup`, `manual`, or `before: <operation>` (taken before a risky one).',
    }),
    kind: z.enum(BACKUP_KINDS),
    dbBytes: z.number().int(),
    filesBytes: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Size of the files export (zip); null = none.' }),
    fileCount: z
      .number()
      .int()
      .openapi({ description: 'Library and memory files in the snapshot.' }),
    agentCount: z.number().int(),
    verified: z.boolean().openapi({
      description:
        '`PRAGMA integrity_check` of the copy answered `ok` and its row counts of library files and agents matched the live database.',
    }),
    error: z.string().nullable(),
    exportError: z.string().nullable(),
  })
  .openapi('Backup')

export const BackupListSchema = z
  .object({
    dir: z.string().openapi({ description: '`TEAM_BACKUP_DIR`: mount it on a persistent volume.' }),
    backups: z.array(BackupSchema),
    lastVerifiedAt: z.number().int().nullable(),
    stale: z.boolean().openapi({
      description: 'No verified snapshot exists, or the newest is older than 36 hours.',
    }),
    enabled: z.boolean(),
    time: z.string().openapi({ description: 'HH:MM in the team timezone.' }),
  })
  .openapi('BackupList')

export const BackupCreatedSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().nullable(),
    backup: BackupSchema.nullable(),
  })
  .openapi('BackupCreated')

export const BackupEntriesSchema = z
  .object({
    files: z.array(
      z.object({ path: z.string(), size: z.number().int(), updatedAt: z.number().int() }),
    ),
  })
  .openapi('BackupEntries')

export const RestoreBodySchema = z
  .object({
    path: z.string().min(1).max(512).openapi({
      description: 'One file, a folder, or `/` for every library and memory file of the snapshot.',
      example: '/memories/agents',
    }),
    mode: z.enum(RESTORE_MODES).default('missing').openapi({
      description:
        '`missing`: only files that are gone; `all`: also replace files whose content differs (the previous version stays in the history).',
    }),
  })
  .openapi('RestoreBody')

const RestoreEntrySchema = z.object({
  path: z.string(),
  action: z.enum(['create', 'replace', 'keep', 'same']),
  snapshotSize: z.number().int(),
  snapshotUpdatedAt: z.number().int(),
  liveSize: z.number().int().nullable(),
  liveUpdatedAt: z.number().int().nullable(),
  liveIsNewer: z.boolean(),
})

export const RestorePlanSchema = z
  .object({
    path: z.string(),
    mode: z.enum(RESTORE_MODES),
    counts: z.object({
      create: z.number().int(),
      replace: z.number().int(),
      keep: z.number().int(),
      same: z.number().int(),
    }),
    entries: z.array(RestoreEntrySchema),
    truncated: z.boolean(),
  })
  .openapi('RestorePlan')

export const RestoreResultSchema = z
  .object({
    created: z.number().int(),
    replaced: z.number().int(),
    unchanged: z.number().int(),
    kept: z.number().int(),
    failed: z.array(z.object({ path: z.string(), error: z.string() })),
    safetyBackupId: z.string().nullable(),
  })
  .openapi('RestoreResult')
