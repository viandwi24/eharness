import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  backupEntries,
  backupNow,
  deleteBackup,
  downloadBackup,
  listBackups,
  previewRestore,
  restoreFiles,
  stageImport,
} from '../../app/backups.ts'
import { IMPORT_LIMITS } from '../../app/catalog.ts'
import type { Deps } from '../../app/ports.ts'
import { exportWorkspace } from '../../app/workspace-export.ts'
import {
  applyImport,
  listRestorePoints,
  previewImport,
  previewUndo,
} from '../../app/workspace-import.ts'
import { requestLimit } from '../body-limit.ts'
import {
  BackupCreatedSchema,
  BackupEntriesSchema,
  BackupListSchema,
  ExportBodySchema,
  ImportBodySchema,
  ImportPreviewBodySchema,
  ImportPreviewSchema,
  ImportResultSchema,
  ImportUploadResultSchema,
  RestoreBodySchema,
  RestorePlanSchema,
  RestorePointListSchema,
  RestoreResultSchema,
  UndoPreviewSchema,
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
  summary: 'Download the workspace export of a backup',
  description:
    'The workspace zip of that backup (the same layout as `GET /backups/export`): readable `.md` and `.json` in folders with `manifest.json` (format, versions, counts, sha256 of every file). Backups made before this format hold a files-only zip that the import refuses.',
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

const exportRoute = createRoute({
  method: 'get',
  path: '/backups/export',
  tags: ['backups'],
  summary: 'Download the workspace export now',
  description:
    'One zip of everything of the workspace, readable as `.md` and `.json` in folders: `manifest.json` (format, versions, counts, sha256 of every file), `settings.json`, `library/**`, `memory/**`, `agents/<slug>/{agent.json,persona.md,heartbeat.json,memory/**,programs/**,routines/**,reminders/**}`, `connections/<label>.json` (never with secrets) and `people/<id>.json`. Chats, task transcripts and logs are not in it (the database snapshot of a backup covers those). The same zip is part of every backup.',
  security,
  responses: downloadResponses,
})

const exportWithSecretsRoute = createRoute({
  method: 'post',
  path: '/backups/export',
  tags: ['backups'],
  summary: 'Download the workspace export now, with encrypted secrets',
  description:
    'The same zip as `GET /backups/export`, plus `secrets.enc.json`: every provider profile key and connection credential (and OAuth client credential), encrypted with AES-256-GCM under a key derived from the `passphrase` (PBKDF2-SHA256, 600 000 iterations, random salt and IV, versioned). `manifest.json` says secrets are included and how many, never their names or values. The passphrase travels in the body, is never stored or logged and cannot be recovered. Scheduled backups and safety backups never hold secrets.',
  security,
  request: { body: { required: true, content: json(ExportBodySchema) } },
  responses: {
    200: { description: 'The bytes, streamed' },
    409: jsonError('`SECRETS_UNAVAILABLE`'),
    ...errorResponses,
  },
})

const uploadRoute = createRoute({
  method: 'post',
  path: '/backups/imports',
  tags: ['backups'],
  summary: 'Upload a workspace zip for an import',
  description: `The raw zip as the request body (\`application/zip\`, \`?name=\` the file name, at most ${IMPORT_LIMITS.zipBytes / 1048576} MB). It is verified before it is kept: size and entry limits, entry names (zip-slip), the manifest and the sha256 of every file. A refused zip answers 400 \`IMPORT_REFUSED\` with the reason. The answer's \`uploadId\` is the source of the preview and the import.`,
  security,
  middleware: [requestLimit(IMPORT_LIMITS.zipBytes + 65_536)] as const,
  request: { query: z.object({ name: z.string().max(200).default('workspace.zip') }) },
  responses: {
    200: { description: 'The staged zip', content: json(ImportUploadResultSchema) },
    413: jsonError('Zip too large'),
    ...errorResponses,
  },
})

const importPreviewRoute = createRoute({
  method: 'post',
  path: '/backups/import-preview',
  tags: ['backups'],
  summary: 'What an import would change',
  description:
    "Compares the zip with the workspace, entity by entity: `added`, `changed` (with a readable diff for text and the changed fields of JSON), `unchanged` (only counted), `only-live` (kept: an import never deletes unless a section is ticked for removal). Each item lists what applying it would grant (`authority`: permission mode, tool rules, connector enablement, program authority, directory roles). Connections and reminders are reference only. With `passphrase` the zip's encrypted secrets are listed by name (never their values); a wrong passphrase answers 400 `IMPORT_PASSPHRASE`. Nothing is written.",
  security,
  request: { body: { required: true, content: json(ImportPreviewBodySchema) } },
  responses: {
    200: { description: 'The preview', content: json(ImportPreviewSchema) },
    404: notFoundResponse,
    ...errorResponses,
  },
})

const importRoute = createRoute({
  method: 'post',
  path: '/backups/import',
  tags: ['backups'],
  summary: 'Apply an import',
  description:
    'Applies the selected sections and items. A verified safety backup is taken first (`BACKUP_FAILED` and nothing applied when it fails) and a restore point is recorded. Ids are kept for matched entities (agent slug, program name per agent, library path, routine id then name, person id then name); new ones get new ids; references are remapped. An item that exists here and differs is skipped unless `selection.overwrite` is true (an undo always overwrites). Secrets come back only from the encrypted `secrets.enc.json`, when `selection.sections` includes `secrets` and the `passphrase` is right (a wrong one answers 400 `IMPORT_PASSPHRASE` and nothing is applied). One failing item does not stop the rest (see `counts.failed`).',
  security,
  request: { body: { required: true, content: json(ImportBodySchema) } },
  responses: {
    200: { description: 'What was applied', content: json(ImportResultSchema) },
    404: notFoundResponse,
    409: jsonError('`BACKUP_FAILED`'),
    ...errorResponses,
  },
})

const restorePointsRoute = createRoute({
  method: 'get',
  path: '/backups/restore-points',
  tags: ['backups'],
  summary: 'Restore points',
  description:
    'Every import or restore with what was applied, from which backup, by whom, when, and the safety backup taken first. Newest first.',
  security,
  responses: {
    200: { description: 'Restore points', content: json(RestorePointListSchema) },
    ...errorResponses,
  },
})

const undoPreviewRoute = createRoute({
  method: 'get',
  path: '/backups/restore-points/{id}/undo',
  tags: ['backups'],
  summary: 'Preview the undo of a restore point',
  description:
    "Undo = an import of the restore point's safety backup. This answers the source, the suggested selection (the touched sections ticked, with removal of what the import added) and the same preview. Apply it with `POST /backups/import` and `undoOf` set; that creates a restore point itself, so an undo can be undone.",
  security,
  request: { params: idParam },
  responses: {
    200: { description: 'The undo preview', content: json(UndoPreviewSchema) },
    404: notFoundResponse,
    409: jsonError('`ALREADY_UNDONE`'),
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
    .openapi(exportRoute, async () => raw(attachment(await exportWorkspace(deps))))
    .openapi(exportWithSecretsRoute, async (c) =>
      raw(attachment(await exportWorkspace(deps, { passphrase: c.req.valid('json').passphrase }))),
    )
    .openapi(uploadRoute, async (c) =>
      c.json(
        await stageImport(
          deps,
          new Uint8Array(await c.req.arrayBuffer()),
          c.req.valid('query').name,
        ),
        200,
      ),
    )
    .openapi(importPreviewRoute, async (c) =>
      c.json(
        await previewImport(deps, c.req.valid('json').source, {
          passphrase: c.req.valid('json').passphrase,
        }),
        200,
      ),
    )
    .openapi(importRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json(
        await applyImport(deps, body.source, body.selection, {
          by: 'web',
          undoOf: body.undoOf,
          passphrase: body.passphrase,
        }),
        200,
      )
    })
    .openapi(restorePointsRoute, (c) => c.json({ restorePoints: listRestorePoints(deps) }, 200))
    .openapi(undoPreviewRoute, async (c) =>
      c.json(await previewUndo(deps, c.req.valid('param').id), 200),
    )
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
