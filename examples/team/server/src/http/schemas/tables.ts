import { z } from '@hono/zod-openapi'
import { COLUMN_TYPES } from '../../app/catalog.ts'

export const ColumnSchema = z
  .object({
    name: z.string().openapi({ description: 'Letters, digits and _, starting with a letter.' }),
    type: z.enum(COLUMN_TYPES as [string, ...string[]]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    indexed: z
      .boolean()
      .optional()
      .openapi({ description: 'Queries on this column use an index.' }),
    unique: z.boolean().optional().openapi({
      description:
        'No two rows share a value (absent and null do not count); text, number or date; implies indexed. A write that repeats a value answers 409 DUPLICATE_KEY.',
    }),
    description: z.string().optional(),
  })
  .openapi('TableColumn')

export const TableSchemaSchema = z
  .object({
    columns: z.array(ColumnSchema).max(200),
    strict: z.boolean().optional().openapi({ description: 'Refuse fields that are not columns.' }),
  })
  .openapi('TableSchema')

export const DataTableSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    schema: TableSchemaSchema,
    createdBy: z.string(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    version: z.number().int(),
    rowCount: z.number().int(),
    bytes: z.number().int(),
  })
  .openapi('DataTable')

export const TableListSchema = z.object({ tables: z.array(DataTableSchema) }).openapi('TableList')

export const TableCreateSchema = z
  .object({
    name: z.string().min(1).max(63).openapi({
      description: 'Lowercase letters, digits and _, starting with a letter.',
    }),
    description: z.string().max(2000).optional(),
    schema: TableSchemaSchema.optional(),
  })
  .openapi('TableCreate')

export const TablePatchSchema = z
  .object({
    name: z.string().min(1).max(63).optional(),
    description: z.string().max(2000).optional(),
    schema: TableSchemaSchema.optional().openapi({
      description: 'Existing rows are not rewritten: a change applies to writes from now on.',
    }),
  })
  .openapi('TablePatch')

export const TableParam = z.object({
  table: z
    .string()
    .min(1)
    .openapi({ param: { name: 'table', in: 'path' }, description: 'Table name or id.' }),
})
export const RowParam = TableParam.extend({
  rowId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'rowId', in: 'path' } }),
})

export const TableRecordSchema = z
  .object({
    id: z.string(),
    data: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    createdBy: z.string(),
    updatedBy: z.string(),
  })
  .openapi('TableRecord')

const FilterSchema = z.record(z.string(), z.unknown()).openapi('TableFilter', {
  description:
    'MongoDB-like: `{ status: "open", price: { $gt: 10 }, $or: [ ... ] }`. Operators: $eq $ne $gt $gte $lt $lte $in $nin $contains $startsWith $exists $has $and $or $not. System fields: _id, _createdAt, _updatedAt, _version.',
})
const ChangeSchema = z
  .object({
    set: z.record(z.string(), z.unknown()).optional(),
    unset: z.array(z.string()).optional(),
    inc: z.record(z.string(), z.number()).optional(),
  })
  .openapi('TableRowChange')

export const RowsInsertSchema = z
  .object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000) })
  .openapi('TableRowsInsert')
export const RowsInsertedSchema = z
  .object({ inserted: z.array(z.string()) })
  .openapi('TableRowsInserted')

export const RowsUpsertSchema = z
  .object({
    key: z.string().openapi({
      description: 'The column that identifies a row (best a unique one); every row must have it.',
    }),
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
  })
  .openapi('TableRowsUpsert')
export const RowsUpsertedSchema = z
  .object({
    inserted: z.array(z.string()),
    updated: z.array(z.string()).openapi({ description: 'Rows whose key existed: fields merged.' }),
  })
  .openapi('TableRowsUpserted')

export const RowPatchSchema = z
  .object({
    change: ChangeSchema,
    ifVersion: z.number().int().optional().openapi({
      description: 'Compare-and-set: the version you read. A newer row answers 409 STALE_ROW.',
    }),
  })
  .openapi('TableRowPatch')

export const RowQuerySchema = z
  .object({
    filter: FilterSchema.optional(),
    sort: z.unknown().optional().openapi({
      description:
        '`{ field: 1 | -1 }` or `[{ field, dir }]`; without it rows come in creation order.',
    }),
    fields: z.array(z.string()).max(200).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  })
  .openapi('TableRowQuery')

export const RowPageSchema = z
  .object({
    rows: z.array(TableRecordSchema),
    next: z.string().nullable(),
    total: z.number().int(),
  })
  .openapi('TableRowPage')

export const AggregateSchema = z
  .object({
    filter: FilterSchema.optional(),
    groupBy: z.array(z.string()).max(3).optional(),
    metrics: z.record(
      z.string(),
      z.object({ op: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().optional() }),
    ),
    sort: z.object({ by: z.string(), dir: z.enum(['asc', 'desc']).optional() }).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .openapi('TableAggregate')

export const AggregateResultSchema = z
  .object({ groups: z.array(z.record(z.string(), z.unknown())) })
  .openapi('TableAggregateResult')

export const RowsUpdateSchema = z
  .object({ filter: FilterSchema, change: ChangeSchema })
  .openapi('TableRowsUpdate')
export const RowsUpdatedSchema = z
  .object({ matched: z.number().int(), updated: z.number().int(), conflicts: z.number().int() })
  .openapi('TableRowsUpdated')

export const RowsDeleteSchema = z.object({ filter: FilterSchema }).openapi('TableRowsDelete')
export const DeletedSchema = z.object({ deleted: z.number().int() }).openapi('TableRowsDeleted')

const FormatSchema = z.enum(['csv', 'json', 'ndjson']).optional().openapi({
  description: 'Default: from the file extension (.csv, .json, .ndjson / .jsonl).',
})

export const ImportSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .openapi({ description: 'A library file (`/library/data/members.csv`).' }),
    format: FormatSchema,
    upsertKey: z.string().optional().openapi({
      description: 'A column: a record whose value matches an existing row updates that row.',
    }),
  })
  .openapi('TableImport')
export const ImportResultSchema = z
  .object({
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errors: z.array(z.string()),
  })
  .openapi('TableImportResult')

export const ExportSchema = z
  .object({
    path: z.string().min(1),
    format: FormatSchema,
    filter: FilterSchema.optional(),
    sort: z.unknown().optional(),
  })
  .openapi('TableExport')
export const ExportResultSchema = z
  .object({ path: z.string(), rows: z.number().int() })
  .openapi('TableExportResult')
