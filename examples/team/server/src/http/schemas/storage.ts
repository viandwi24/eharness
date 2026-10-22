import { z } from '@hono/zod-openapi'
import { STORAGE_ACTIONS, TABLE_GROUPS } from '../../app/catalog.ts'

const bytes = (description: string) => z.number().int().nonnegative().openapi({ description })

const VolumeSchema = z.object({
  path: z.string(),
  totalBytes: bytes('Size of the volume.'),
  usedBytes: bytes('Used space.'),
  freeBytes: bytes('Space a normal process can still write.'),
})

const TableUsageSchema = z.object({
  name: z.string(),
  group: z.enum(TABLE_GROUPS),
  rows: z.number().int().nullable(),
  bytes: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Table plus indexes; null without `dbstat`.' }),
})

const DirUsageSchema = z.object({
  id: z.string().openapi({ description: '`code-scratch`, `code-env` or `browser`.' }),
  label: z.string(),
  path: z.string(),
  exists: z.boolean(),
  bytes: z.number().int(),
  files: z.number().int(),
  approximate: z.boolean().openapi({ description: 'The walk hit its cap: lower bounds.' }),
  children: z.array(z.object({ name: z.string(), bytes: z.number().int() })),
})

export const StorageSchema = z
  .object({
    scannedAt: z.number().int(),
    tookMs: z.number().int(),
    dataDir: z.string().openapi({ description: 'Absolute path of the folder with the database.' }),
    volume: VolumeSchema.nullable(),
    database: z.object({
      file: z.string(),
      dbBytes: z.number().int(),
      walBytes: z.number().int(),
      shmBytes: z.number().int(),
      totalBytes: z.number().int(),
      pageSize: z.number().int(),
      pageCount: z.number().int(),
      freelistPages: z.number().int(),
      reclaimableBytes: z.number().int(),
      autoVacuum: z.enum(['none', 'full', 'incremental']),
      perTableBytes: z.boolean(),
      tables: z.array(TableUsageSchema).openapi({ description: 'The 15 biggest tables.' }),
      groups: z.array(
        z.object({
          group: z.enum(TABLE_GROUPS),
          label: z.string(),
          rows: z.number().int(),
          bytes: z.number().int().nullable(),
        }),
      ),
    }),
    library: z.object({
      files: z.number().int(),
      bytes: z.number().int(),
      folders: z.array(
        z.object({ folder: z.string(), files: z.number().int(), bytes: z.number().int() }),
      ),
      history: z.object({ versions: z.number().int(), bytes: z.number().int().nullable() }),
    }),
    backups: z
      .object({
        path: z.string(),
        exists: z.boolean(),
        files: z.number().int(),
        snapshots: z.number().int(),
        totalBytes: z.number().int(),
        newestAt: z.number().nullable(),
        oldestAt: z.number().nullable(),
        sameVolume: z.boolean().nullable(),
      })
      .nullable(),
    others: z.array(DirUsageSchema),
    keys: z.array(
      z.object({
        file: z.string(),
        env: z.string(),
        present: z.boolean(),
        envSet: z.boolean(),
      }),
    ),
    warnings: z.array(
      z.object({
        code: z.enum(['low-disk', 'backups-same-disk', 'key-file', 'approximate', 'reclaimable']),
        text: z.string(),
      }),
    ),
  })
  .openapi('Storage')

export const StorageQuerySchema = z.object({
  refresh: z
    .enum(['1', 'true'])
    .optional()
    .openapi({ description: 'Scan again instead of using the report of the last 60 seconds.' }),
})

export const StorageActionParamSchema = z.object({
  action: z
    .enum(STORAGE_ACTIONS)
    .openapi({ param: { name: 'action', in: 'path' }, example: 'checkpoint' }),
})

export const StorageActionBodySchema = z
  .object({
    confirm: z.boolean().openapi({ description: 'Must be true: the owner confirmed the action.' }),
    days: z.number().int().min(1).max(3650).optional().openapi({
      description: '`clear-media` only: media older than this many days go (default 3).',
    }),
  })
  .openapi('StorageActionBody')

const SizesSchema = z.object({
  dbBytes: z.number().int(),
  walBytes: z.number().int(),
  freeBytes: z.number().int().nullable(),
})

export const StorageActionResultSchema = z
  .object({
    action: z.enum(STORAGE_ACTIONS),
    message: z.string(),
    before: SizesSchema,
    after: SizesSchema,
    detail: z.record(z.string(), z.number()),
  })
  .openapi('StorageActionResult')
