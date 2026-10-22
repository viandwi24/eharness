import { z } from '@hono/zod-openapi'
import { BACKUP_KINDS, RESTORE_MODES, WORKSPACE_SECTIONS } from '../../app/catalog.ts'

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
      .openapi({ description: 'Size of the workspace export (zip); null = none.' }),
    fileCount: z
      .number()
      .int()
      .openapi({ description: 'Library and memory files in the workspace export.' }),
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
    restorePointId: z.string().nullable().openapi({
      description: 'The restore point recorded for this restore (null when nothing was restored).',
    }),
  })
  .openapi('RestoreResult')

// --- the workspace export and import -----------------------------------------------------------

const SECTION_IDS = WORKSPACE_SECTIONS

export const ImportSourceSchema = z
  .union([
    z.object({ backupId: z.string().min(1).max(100) }),
    z.object({ uploadId: z.string().min(1).max(100) }),
  ])
  .openapi('ImportSource', {
    description:
      'Where the import reads from: `{ backupId }` (the workspace zip of a stored backup) or `{ uploadId }` (a zip uploaded with `POST /backups/imports`).',
  })

export const ImportUploadResultSchema = z
  .object({ uploadId: z.string(), name: z.string() })
  .openapi('ImportUpload')

export const ImportSelectionSchema = z
  .object({
    sections: z.array(z.enum(SECTION_IDS)).optional().openapi({
      description: 'Sections to apply (default: every section that can be imported).',
    }),
    exclude: z.array(z.string().max(700)).max(50_000).optional().openapi({
      description: 'Keys (zip paths) of single items that are unticked.',
    }),
    removeSections: z.array(z.enum(SECTION_IDS)).optional().openapi({
      description:
        'Sections where what is only in the workspace is removed too (default none: an import never deletes). Agents are archived. `secrets` cannot be removed.',
    }),
    overwrite: z.boolean().optional().openapi({
      description:
        'Default `false`: an item that exists here and differs is SKIPPED, only new items are added. `true` also replaces the differing ones. An undo (`undoOf`) always overwrites.',
    }),
  })
  .openapi('ImportSelection')

const FieldChangeSchema = z.object({ field: z.string(), before: z.string(), after: z.string() })

export const ImportItemSchema = z
  .object({
    key: z.string().openapi({ description: 'The zip path of the item; unticking uses it.' }),
    section: z.enum(SECTION_IDS),
    kind: z.string(),
    label: z.string(),
    status: z.enum(['added', 'changed', 'unchanged', 'only-live']),
    applicable: z.boolean(),
    blocked: z.string().nullable(),
    fields: z.array(FieldChangeSchema).openapi({ description: 'Changed fields of a JSON entity.' }),
    diff: z.string().nullable().openapi({ description: 'A line diff of a text entry.' }),
    authority: z.array(z.string()).openapi({
      description:
        'What applying it would grant: permission mode, tool rules, connector enablement, program authority, directory roles.',
    }),
    notes: z.array(z.string()),
    sizeBefore: z.number().int().nullable(),
    sizeAfter: z.number().int().nullable(),
  })
  .openapi('ImportItem')

export const ImportPreviewSchema = z
  .object({
    source: z.object({ kind: z.enum(['backup', 'upload']), id: z.string() }),
    manifest: z.object({
      createdAt: z.number().int(),
      appVersion: z.string(),
      formatVersion: z.number().int(),
      counts: z.record(z.string(), z.number()),
    }),
    sections: z.array(
      z.object({
        id: z.enum(SECTION_IDS),
        label: z.string(),
        added: z.number().int(),
        changed: z.number().int(),
        unchanged: z.number().int(),
        onlyLive: z.number().int(),
        applicable: z.boolean(),
      }),
    ),
    secrets: z.object({
      included: z.boolean().openapi({ description: 'The zip holds `secrets.enc.json`.' }),
      count: z
        .number()
        .int()
        .openapi({ description: 'How many secrets (a count, never names or values).' }),
      unlocked: z.boolean().openapi({
        description:
          'The passphrase of the request opened them: the `secrets` section lists them by name.',
      }),
    }),
    items: z.array(ImportItemSchema).openapi({
      description: 'Added, changed and only-in-workspace items (unchanged ones are only counted).',
    }),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  })
  .openapi('ImportPreview')

const PassphraseSchema = z.string().min(1).max(256)

export const ImportPreviewBodySchema = z
  .object({
    source: ImportSourceSchema,
    passphrase: PassphraseSchema.optional().openapi({
      description:
        'The passphrase of the export, to list its secrets by name. A wrong one answers 400 `IMPORT_PASSPHRASE`. Never stored or logged.',
    }),
  })
  .openapi('ImportPreviewBody')

export const ExportBodySchema = z
  .object({
    passphrase: z.string().min(12).max(256).openapi({
      description:
        'At least 12 characters. Provider keys and connection credentials are encrypted with a key derived from it (PBKDF2-SHA256, AES-256-GCM) into `secrets.enc.json`. It cannot be recovered: keep it.',
    }),
  })
  .openapi('ExportBody')

export const ImportBodySchema = z
  .object({
    source: ImportSourceSchema,
    selection: ImportSelectionSchema.optional(),
    passphrase: PassphraseSchema.optional().openapi({
      description:
        'The passphrase of the export; required when `selection.sections` includes `secrets`. Checked before anything is written.',
    }),
    undoOf: z.string().min(1).max(100).optional().openapi({
      description: 'The restore point this import undoes (marks it as undone).',
    }),
  })
  .openapi('ImportBody')

const RestorePointItemSchema = z.object({
  key: z.string(),
  action: z.enum(['added', 'changed', 'removed', 'failed']),
  note: z.string().optional(),
})

export const RestorePointSchema = z
  .object({
    id: z.string(),
    at: z.number().int(),
    by: z.string(),
    kind: z.enum(['import', 'files-restore', 'undo', 'memory-reorganization']),
    source: z.union([
      z.object({ kind: z.literal('backup'), backupId: z.string(), label: z.string() }),
      z.object({ kind: z.literal('upload'), label: z.string() }),
    ]),
    safetyBackupId: z
      .string()
      .openapi({ description: 'The verified backup taken right before; undo restores from it.' }),
    sections: z.array(z.string()),
    removedSections: z.array(z.string()),
    counts: z.object({
      added: z.number().int(),
      changed: z.number().int(),
      removed: z.number().int(),
      failed: z.number().int(),
    }),
    items: z.array(RestorePointItemSchema),
    undoOf: z.string().nullable(),
    undoneBy: z.string().nullable(),
  })
  .openapi('RestorePoint')

export const RestorePointListSchema = z
  .object({ restorePoints: z.array(RestorePointSchema) })
  .openapi('RestorePointList')

export const ImportResultSchema = z
  .object({
    restorePointId: z.string().nullable().openapi({
      description:
        'Null when nothing was selected to change: no safety backup and no restore point.',
    }),
    safetyBackupId: z.string().nullable(),
    counts: z.object({
      added: z.number().int(),
      changed: z.number().int(),
      removed: z.number().int(),
      failed: z.number().int(),
    }),
    items: z.array(RestorePointItemSchema),
  })
  .openapi('ImportResult')

export const UndoPreviewSchema = z
  .object({
    restorePoint: RestorePointSchema,
    source: ImportSourceSchema,
    selection: z.object({
      sections: z.array(z.enum(SECTION_IDS)),
      exclude: z.array(z.string()),
      removeSections: z.array(z.enum(SECTION_IDS)),
      overwrite: z.boolean(),
    }),
    preview: ImportPreviewSchema,
  })
  .openapi('UndoPreview')
