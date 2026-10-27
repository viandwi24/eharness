import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  aggregateRows,
  createTable,
  deleteRow,
  deleteRows,
  dropTable,
  exportRows,
  getRow,
  getTable,
  importRows,
  insertRows,
  listTables,
  queryRows,
  updateRow,
  updateRows,
  updateTable,
  upsertRows,
} from '../../app/tables.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  AggregateResultSchema,
  AggregateSchema,
  DataTableSchema,
  DeletedSchema,
  ExportResultSchema,
  ExportSchema,
  ImportResultSchema,
  ImportSchema,
  RowPageSchema,
  RowParam,
  RowPatchSchema,
  RowQuerySchema,
  RowsDeleteSchema,
  RowsInsertedSchema,
  RowsInsertSchema,
  RowsUpdatedSchema,
  RowsUpdateSchema,
  RowsUpsertedSchema,
  RowsUpsertSchema,
  TableCreateSchema,
  TableListSchema,
  TableParam,
  TablePatchSchema,
  TableRecordSchema,
} from '../schemas/tables.ts'

const security = [{ Bearer: [] }]
const tags = ['tables']
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const unknownTable = jsonError('Unknown table')
/** The web app and the API act as the owner. */
const OWNER = 'web owner'

const listRoute = createRoute({
  method: 'get',
  path: '/tables',
  tags,
  summary: 'List tables',
  security,
  responses: { 200: { description: 'Tables', content: json(TableListSchema) }, ...errorResponses },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/tables',
  tags,
  summary: 'Create a table',
  security,
  request: { body: { required: true, content: json(TableCreateSchema) } },
  responses: {
    201: { description: 'The table', content: json(DataTableSchema) },
    409: jsonError('A table with that name exists'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/tables/{table}',
  tags,
  summary: 'A table',
  security,
  request: { params: TableParam },
  responses: {
    200: { description: 'The table', content: json(DataTableSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/tables/{table}',
  tags,
  summary: 'Rename, describe or change the schema',
  security,
  request: { params: TableParam, body: { required: true, content: json(TablePatchSchema) } },
  responses: {
    200: { description: 'The table', content: json(DataTableSchema) },
    404: unknownTable,
    409: jsonError('A table with that name exists'),
    ...errorResponses,
  },
})

const dropRoute = createRoute({
  method: 'delete',
  path: '/tables/{table}',
  tags,
  summary: 'Drop a table and its rows',
  security,
  request: { params: TableParam },
  responses: {
    200: { description: 'The dropped table', content: json(DataTableSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const insertRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/rows',
  tags,
  summary: 'Insert rows (at most 1000)',
  security,
  request: { params: TableParam, body: { required: true, content: json(RowsInsertSchema) } },
  responses: {
    201: { description: 'Ids of the new rows', content: json(RowsInsertedSchema) },
    404: unknownTable,
    409: jsonError('A size limit of Settings would be passed'),
    ...errorResponses,
  },
})

const upsertRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/upsert',
  tags,
  summary: 'Insert or update rows by a key column (at most 1000)',
  security,
  request: { params: TableParam, body: { required: true, content: json(RowsUpsertSchema) } },
  responses: {
    200: { description: 'Ids of the new and the changed rows', content: json(RowsUpsertedSchema) },
    404: unknownTable,
    409: jsonError('A unique column would repeat a value, or a size limit would be passed'),
    ...errorResponses,
  },
})

const getRowRoute = createRoute({
  method: 'get',
  path: '/tables/{table}/rows/{rowId}',
  tags,
  summary: 'One row',
  security,
  request: { params: RowParam },
  responses: {
    200: { description: 'The row', content: json(TableRecordSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const patchRowRoute = createRoute({
  method: 'patch',
  path: '/tables/{table}/rows/{rowId}',
  tags,
  summary: 'Change one row',
  security,
  request: { params: RowParam, body: { required: true, content: json(RowPatchSchema) } },
  responses: {
    200: { description: 'The row', content: json(TableRecordSchema) },
    404: unknownTable,
    409: jsonError('The row changed since it was read (STALE_ROW) or a size limit would be passed'),
    ...errorResponses,
  },
})

const deleteRowRoute = createRoute({
  method: 'delete',
  path: '/tables/{table}/rows/{rowId}',
  tags,
  summary: 'Delete one row',
  security,
  request: { params: RowParam },
  responses: {
    200: { description: 'Deleted', content: json(DeletedSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const queryRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/query',
  tags,
  summary: 'Query rows',
  security,
  request: { params: TableParam, body: { required: true, content: json(RowQuerySchema) } },
  responses: {
    200: { description: 'A page of rows', content: json(RowPageSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const aggregateRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/aggregate',
  tags,
  summary: 'Count, sum, average, min, max',
  security,
  request: { params: TableParam, body: { required: true, content: json(AggregateSchema) } },
  responses: {
    200: { description: 'Groups', content: json(AggregateResultSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const updateRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/update',
  tags,
  summary: 'Change rows matching a filter',
  security,
  request: { params: TableParam, body: { required: true, content: json(RowsUpdateSchema) } },
  responses: {
    200: { description: 'Counts', content: json(RowsUpdatedSchema) },
    404: unknownTable,
    409: jsonError('A size limit of Settings would be passed'),
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/delete',
  tags,
  summary: 'Delete rows matching a filter',
  security,
  request: { params: TableParam, body: { required: true, content: json(RowsDeleteSchema) } },
  responses: {
    200: { description: 'Deleted', content: json(DeletedSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

const importRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/import',
  tags,
  summary: 'Import rows from a library file',
  security,
  request: { params: TableParam, body: { required: true, content: json(ImportSchema) } },
  responses: {
    200: { description: 'What was imported', content: json(ImportResultSchema) },
    404: unknownTable,
    409: jsonError('A size limit of Settings would be passed'),
    ...errorResponses,
  },
})

const exportRoute = createRoute({
  method: 'post',
  path: '/tables/{table}/export',
  tags,
  summary: 'Export rows to a library file',
  security,
  request: { params: TableParam, body: { required: true, content: json(ExportSchema) } },
  responses: {
    200: { description: 'Where the rows went', content: json(ExportResultSchema) },
    404: unknownTable,
    ...errorResponses,
  },
})

export function tableRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => c.json({ tables: listTables(deps) } as never, 200))
    .openapi(createRoute_, (c) => {
      const body = c.req.valid('json')
      return c.json(createTable(deps, OWNER, body) as never, 201)
    })
    .openapi(getRoute, (c) => c.json(getTable(deps, c.req.valid('param').table) as never, 200))
    .openapi(patchRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(updateTable(deps, OWNER, c.req.valid('param').table, body) as never, 200)
    })
    .openapi(dropRoute, (c) =>
      c.json(dropTable(deps, OWNER, c.req.valid('param').table) as never, 200),
    )
    .openapi(insertRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(insertRows(deps, OWNER, c.req.valid('param').table, body.rows) as never, 201)
    })
    .openapi(upsertRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(
        upsertRows(deps, OWNER, c.req.valid('param').table, body.key, body.rows) as never,
        200,
      )
    })
    .openapi(getRowRoute, (c) => {
      const p = c.req.valid('param')
      return c.json(getRow(deps, p.table, p.rowId) as never, 200)
    })
    .openapi(patchRowRoute, (c) => {
      const p = c.req.valid('param')
      const body = c.req.valid('json')
      return c.json(
        updateRow(deps, OWNER, p.table, p.rowId, body.change, body.ifVersion) as never,
        200,
      )
    })
    .openapi(deleteRowRoute, (c) => {
      const p = c.req.valid('param')
      return c.json(deleteRow(deps, OWNER, p.table, p.rowId) as never, 200)
    })
    .openapi(queryRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(queryRows(deps, c.req.valid('param').table, body) as never, 200)
    })
    .openapi(aggregateRoute, (c) =>
      c.json(aggregateRows(deps, c.req.valid('param').table, c.req.valid('json')) as never, 200),
    )
    .openapi(updateRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(
        updateRows(deps, OWNER, c.req.valid('param').table, body.filter, body.change) as never,
        200,
      )
    })
    .openapi(deleteRoute, (c) => {
      const body = c.req.valid('json')
      return c.json(deleteRows(deps, OWNER, c.req.valid('param').table, body.filter) as never, 200)
    })
    .openapi(importRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json((await importRows(deps, OWNER, c.req.valid('param').table, body)) as never, 200)
    })
    .openapi(exportRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json((await exportRows(deps, c.req.valid('param').table, body)) as never, 200)
    })
}
