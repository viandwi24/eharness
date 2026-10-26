# Tables

Document tables the owner, the agents and [scripts](scripts.md) keep structured data in: lists,
counters, ledgers, imported records. A table has a name, an optional schema and rows; each row is a
JSON document. Queries use MongoDB-like filters; there is no raw SQL. Agents use the `tables_read`
and `tables_write` tools; people use the Tables page. Decision:
[ADR-0065](../../../docs/decisions/0065-scripts-and-tables.md), plan:
[P59](../../../docs/plans/P59-scripts-and-tables.md).

- [Tables and schemas](#tables-and-schemas)
- [Rows](#rows)
- [Queries](#queries)
- [Aggregates](#aggregates)
- [Changing rows](#changing-rows)
- [Import and export](#import-and-export)
- [Limits](#limits)
- [API](#api)
- [Storage](#storage)

## Tables and schemas

A table name is lowercase letters, digits and `_`, starting with a letter. The schema is optional:

```json
{
  "name": "members",
  "description": "Community members",
  "schema": {
    "columns": [
      { "name": "name", "type": "string", "required": true },
      { "name": "city", "type": "string", "indexed": true },
      { "name": "points", "type": "number", "default": 0 },
      { "name": "joined", "type": "date" }
    ],
    "strict": false
  }
}
```

- Types: `string`, `number`, `boolean`, `date` (stored as an ISO 8601 string), `json` (anything).
- `required` refuses a row without the field (after defaults); `default` fills a missing field on
  insert; `indexed` gives the column an index so filters and sorts on it stay fast.
- `strict: true` refuses fields that are not columns. Without it, a row may carry extra fields.
- Changing the schema does not rewrite existing rows: a new type or a new required column applies
  to writes from then on.

## Rows

Every row has system fields next to its document: `_id` (a UUIDv7, so ids sort by creation time),
`_createdAt`, `_updatedAt`, `_version` (bumped by every change), and who created and last changed
it. Field names starting with `_` are reserved. A row is at most 256 KB.

## Queries

`POST /tables/{table}/query` with `filter`, `sort`, `fields`, `limit` (default 50, at most 1000)
and `cursor`:

```json
{
  "filter": { "city": "Jakarta", "points": { "$gte": 10 }, "$or": [{ "vip": true }, { "tags": { "$has": "core" } }] },
  "sort": { "points": -1 },
  "fields": ["name", "points"],
  "limit": 20
}
```

| Operator | Meaning |
|---|---|
| `field: value` / `$eq` | equal (`null` matches a missing or null field) |
| `$ne` | not equal (a missing field counts as not equal) |
| `$gt $gte $lt $lte` | compare numbers, or text and dates as text |
| `$in` / `$nin` | one of / none of a list (at most 500 values) |
| `$contains` | text contains, ignoring case |
| `$startsWith` | text starts with (case-sensitive) |
| `$exists` | the field is present (`true`) or absent (`false`) |
| `$has` | a list field contains the value |
| `$and` `$or` `$not` | combine filters |

Fields can be nested with dots (`customer.city`, at most 5 levels) and include the system fields.
The answer has `rows`, `total` (rows matching the filter) and `next`: pass it back as `cursor` for
the next page. Without a `sort` the order is creation order and paging is stable while rows are
added; with a `sort` the cursor is an offset.

## Aggregates

`POST /tables/{table}/aggregate`:

```json
{
  "filter": { "day": { "$gte": "2026-10-01" } },
  "groupBy": ["city"],
  "metrics": { "members": { "op": "count" }, "points": { "op": "sum", "field": "points" } },
  "sort": { "by": "points", "dir": "desc" },
  "limit": 10
}
```

Metrics: `count`, `sum`, `avg`, `min`, `max`; group by up to 3 fields; sort by a group field or a
metric. The answer is `{ "groups": [{ "city": "Jakarta", "members": 9, "points": 108 }, ...] }`.

## Changing rows

- One row: `PATCH /tables/{table}/rows/{rowId}` with `{ "change": { "set": {...}, "unset": [...], "inc": {...} }, "ifVersion": 3 }`.
  With `ifVersion` the change is refused (`409 STALE_ROW`) when somebody changed the row since it
  was read.
- Many rows: `POST /tables/{table}/update` with `{ "filter", "change" }` (at most 10 000 rows).
- Delete: one row by id, or `POST /tables/{table}/delete` with a non-empty filter (at most 10 000).
- Every change is validated against the schema; one bad row refuses the whole request with the
  reason per row.

## Import and export

- `POST /tables/{table}/import` with `{ "path": "/library/data/members.csv" }`: CSV (header line,
  quoted fields), a JSON array of objects, or NDJSON; the format follows the extension or `format`.
  CSV cells take the column types (numbers, `true/yes/1`, JSON). With `upsertKey` a record whose
  key matches an existing row updates that row. Bad records are skipped and the first 20 reasons
  are returned.
- `POST /tables/{table}/export` with `{ "path", "filter"?, "sort"?, "format"? }` writes the rows to a
  library file. A CSV export starts with `_id` and guards cells against spreadsheet formulas. An
  exported file imports back (the `_id` column is ignored).

Measured on a laptop: importing 100 000 CSV rows takes about 0.3 s, a filtered and sorted query
about 15 ms, a grouped aggregate about 35 ms, and exporting 100 000 rows about 0.2 s.

## Limits

Settings > Limits: **Rows per table** (default 1 000 000, `TEAM_TABLE_MAX_ROWS`) and **Size of all
tables** (default 1024 MB, `TEAM_TABLES_MAX_MB`). A write past either is refused with
`409 TABLE_FULL` / `TABLES_FULL` and a sentence naming the setting. Fixed limits: 200 columns,
256 KB per row, 1000 rows per insert request, 100 conditions per filter, 8 levels of nesting.

## API

All routes are in the OpenAPI document (`/openapi.json`, `shared/openapi.json`).

| Route | |
|---|---|
| `GET /tables`, `POST /tables` | list, create |
| `GET/PATCH/DELETE /tables/{table}` | read, rename/describe/change schema, drop (with its rows) |
| `POST /tables/{table}/rows` | insert rows |
| `GET/PATCH/DELETE /tables/{table}/rows/{rowId}` | one row |
| `POST /tables/{table}/query`, `/aggregate` | read |
| `POST /tables/{table}/update`, `/delete` | change or remove by filter |
| `POST /tables/{table}/import`, `/export` | library files |

`{table}` is the table name or id.

## Storage

Migration `0047_data_tables`: `data_tables` (definitions with running row and byte counters, kept
in step in the same transaction as every write) and `data_rows` (the documents). An indexed column
gets an expression index `data_rows_x_<column>` over `(table_id, json_extract(data, '$.<column>'))`,
shared by every table with that column. Both tables are covered by the database snapshot; to move
one table on its own, export it to the library and import it elsewhere.
