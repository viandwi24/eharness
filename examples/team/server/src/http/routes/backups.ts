import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  backupEntries,
  backupNow,
  deleteBackup,
  downloadBackup,
  listBackups,
  previewRestore,
  restoreFiles,
} from '../../app/backups.ts'
import type { Deps } from '../../app/ports.ts'
import {
  BackupCreatedSchema,
  BackupEntriesSchema,
  BackupListSchema,
  RestoreBodySchema,
  RestorePlanSchema,
  RestoreResultSchema,
} from '../schemas/backups.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const raw = (response: Response): never => response as never
const idParam = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .openapi({ param: { name: 'id', in: 'path' } }),
})
const notFoundResponse = jsonError('`NOT_FOUND`')

const listRoute = createRoute({
  method: 'get',
  path: '/backups',
  tags: ['backups'],
  summary: 'Snapshots of the database',
  description:
    'Newest first, with whether each verified. `stale` is true when there is no verified snapshot or the newest is older than 36 hours.',
  security,
  responses: {
    200: { description: 'Snapshots', content: json(BackupListSchema) },
    ...errorResponses,
  },
})

const createBackupRoute = createRoute({
  method: 'post',
  path: '/backups',
  tags: ['backups'],
  summary: 'Back up now',
  description:
    'A consistent copy of the whole database (`VACUUM INTO`, online) plus a zip of every library and memory file, verified after writing. A failure answers 200 with `ok: false` and also raises an alarm.',
  security,
  responses: {
    200: { description: 'The result', content: json(BackupCreatedSchema) },
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/backups/{id}',
  tags: ['backups'],
  summary: 'Delete a snapshot',
  description: 'The newest verified snapshot cannot be deleted (`BACKUP_NEWEST`).',
  security,
  request: { params: idParam },
  responses: {
    200: { description: 'Deleted', content: json(z.object({ deleted: z.literal(true) })) },
    404: notFoundResponse,
    409: jsonError('`BACKUP_NEWEST`'),
    ...errorResponses,
  },
})

const downloadResponses = {
  200: { description: 'The bytes, streamed' },
  404: notFoundResponse,
  ...errorResponses,
}

const dbRoute = createRoute({
  method: 'get',
  path: '/backups/{id}/db',
  tags: ['backups'],
  summary: 'Download the database snapshot',
  description: 'The SQLite file as it was at the snapshot (open it with any SQLite tool).',
  security,
  request: { params: idParam },
  responses: downloadResponses,
})

const filesRoute = createRoute({
  method: 'get',
  path: '/backups/{id}/files',
  tags: ['backups'],
  summary: 'Download the files export',
  description:
    'A zip with every library and memory file as a folder tree (`library/...`, `memories/agents/<agent slug>/...`) and `manifest.json` (path, size, sha256, updatedAt).',
  security,
  request: { params: idParam },
  responses: downloadResponses,
})

const entriesRoute = createRoute({
  method: 'get',
  path: '/backups/{id}/entries',
  tags: ['backups'],
  summary: 'Files inside a snapshot',
  security,
  request: {
    params: idParam,
    query: z.object({
      prefix: z.string().max(512).default('/'),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }),
  },
  responses: {
    200: { description: 'Files', content: json(BackupEntriesSchema) },
    404: notFoundResponse,
    ...errorResponses,
  },
})

const previewRoute = createRoute({
  method: 'post',
  path: '/backups/{id}/restore-preview',
  tags: ['backups'],
  summary: 'What a restore of files would change',
  description:
    'Compares the files of the snapshot under `path` with the live ones: `create` (gone now), `replace` (differs; only in mode `all`), `keep` (differs, left alone in mode `missing`), `same`. Nothing is written.',
  security,
  request: { params: idParam, body: { required: true, content: json(RestoreBodySchema) } },
  responses: {
    200: { description: 'The plan', content: json(RestorePlanSchema) },
    404: notFoundResponse,
    ...errorResponses,
  },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/backups/{id}/restore',
  tags: ['backups'],
  summary: 'Restore files from a snapshot',
  description:
    'Writes the files back as new versions (the previous version stays in the history) and never deletes anything. A full safety snapshot is taken first; when it fails nothing is restored (`BACKUP_FAILED`).',
  security,
  request: { params: idParam, body: { required: true, content: json(RestoreBodySchema) } },
  responses: {
    200: { description: 'What was restored', content: json(RestoreResultSchema) },
    404: notFoundResponse,
    409: jsonError('`BACKUP_FAILED`'),
    ...errorResponses,
  },
})

const attachment = (d: ReturnType<typeof downloadBackup>): Response =>
  new Response(d.stream, {
    headers: {
      'content-type': d.mediaType,
      'content-length': String(d.size),
      'content-disposition': `attachment; filename="${d.filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })

export function backupRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => c.json(listBackups(deps), 200))
    .openapi(createBackupRoute, async (c) => {
      const out = await backupNow(deps)
      return c.json(
        {
          ok: out.ok,
          error: out.ok ? null : out.error,
          backup: out.backup ?? null,
        },
        200,
      )
    })
    .openapi(deleteRoute, (c) => {
      deleteBackup(deps, c.req.valid('param').id)
      return c.json({ deleted: true as const }, 200)
    })
    .openapi(dbRoute, (c) => raw(attachment(downloadBackup(deps, c.req.valid('param').id, 'db'))))
    .openapi(filesRoute, (c) =>
      raw(attachment(downloadBackup(deps, c.req.valid('param').id, 'files'))),
    )
    .openapi(entriesRoute, (c) => {
      const q = c.req.valid('query')
      return c.json({ files: backupEntries(deps, c.req.valid('param').id, q.prefix, q.limit) }, 200)
    })
    .openapi(previewRoute, (c) =>
      c.json(previewRestore(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(restoreRoute, async (c) =>
      c.json(await restoreFiles(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
}
