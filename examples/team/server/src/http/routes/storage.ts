import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import { getStorage, runStorageAction } from '../../app/storage.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  StorageActionBodySchema,
  StorageActionParamSchema,
  StorageActionResultSchema,
  StorageQuerySchema,
  StorageSchema,
} from '../schemas/storage.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const getRoute = createRoute({
  method: 'get',
  path: '/storage',
  tags: ['storage'],
  summary: 'Where the data lives and how big it is',
  description:
    'The data directory and its volume (total, used, free), the database (files, pages, per-table size by feature), the library by folder, the backups directory, other directories (code scratch, code environments, browser) and the key files, with warnings. The scan is reused for 60 seconds; `refresh=1` scans again. Directory sizes are bounded walks and say `approximate` when capped.',
  security,
  request: { query: StorageQuerySchema },
  responses: {
    200: { description: 'The report', content: json(StorageSchema) },
    409: jsonError('`STORAGE_UNAVAILABLE`: in-memory database'),
    ...errorResponses,
  },
})

const actionRoute = createRoute({
  method: 'post',
  path: '/storage/actions/{action}',
  tags: ['storage'],
  summary: 'Run a maintenance action',
  description:
    '`compact` (VACUUM: needs free disk about the size of the database and blocks writes briefly; refused with `STORAGE_LOW_SPACE` when there is not enough), `checkpoint` (truncate the WAL), `retention` (the retention cleanups of Settings > Data retention) and `clear-media` (tool media and screenshots older than `days`). Needs `confirm: true`. The answer has the sizes before and after.',
  security,
  request: {
    params: StorageActionParamSchema,
    body: { required: true, content: json(StorageActionBodySchema) },
  },
  responses: {
    200: { description: 'What was done', content: json(StorageActionResultSchema) },
    409: jsonError('`STORAGE_LOW_SPACE`, `STORAGE_BUSY` or `STORAGE_UNAVAILABLE`'),
    ...errorResponses,
  },
})

export function storageRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(getRoute, async (c) => {
      const { refresh } = c.req.valid('query')
      return c.json(await getStorage(deps, { refresh: refresh !== undefined }), 200)
    })
    .openapi(actionRoute, async (c) => {
      const { action } = c.req.valid('param')
      const body = c.req.valid('json')
      return c.json(
        await runStorageAction(deps, action, {
          confirm: body.confirm,
          days: body.days,
        }),
        200,
      )
    })
}
