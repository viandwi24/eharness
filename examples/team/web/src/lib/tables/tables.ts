// Pure helpers of the Tables pages: values by column type, the filter builder, sorting, the
// column list of the grid, schema drafts and aggregate specs. No Svelte, no fetch.
import type { components } from '../api/schema';

export type DataTable = components['schemas']['DataTable'];
export type TableSchema = components['schemas']['TableSchema'];
export type TableColumn = components['schemas']['TableColumn'];
export type TableRecord = components['schemas']['TableRecord'];
export type TableAggregate = components['schemas']['TableAggregate'];
export type TableImportResult = components['schemas']['TableImportResult'];
export type ColumnType = TableColumn['type'];
export type Filter = Record<string, unknown>;
export type Sort = { field: string; dir: 1 | -1 } | null;

export const COLUMN_TYPES: readonly ColumnType[] = ['string', 'number', 'boolean', 'date', 'json'];

/** System fields a filter or a sort may use (the row's id, times and version). */
export const SYSTEM_FIELDS: readonly string[] = ['_id', '_createdAt', '_updatedAt', '_version'];

/** Same rule as the server: lowercase letters, digits and `_`, starting with a letter. */
export const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Column names: letters, digits and `_`, starting with a letter. */
export const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Human-readable size: B, KB, MB, GB. */
export function formatBytes(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return '';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** The type a value looks like, for fields that are not columns. */
export function inferType(value: unknown): ColumnType {
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'string' || value === undefined || value === null) return 'string';
	return 'json';
}

export type Parsed = { ok: true; value: unknown } | { ok: true; unset: true } | { ok: false; error: string };

const TRUE = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off']);

/**
 * Text typed into a cell or a form, converted by column type. Empty text means "no value"
 * (`unset`). A json column takes JSON; a date column takes anything `Date` reads (the server
 * stores it as ISO 8601).
 */
export function parseValue(input: string, type: ColumnType): Parsed {
	const text = type === 'string' ? input : input.trim();
	if (text === '') return { ok: true, unset: true };
	switch (type) {
		case 'string':
			return { ok: true, value: text };
		case 'number': {
			const n = Number(text.replace(/[\s_]/g, ''));
			return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `"${text}" is not a number` };
		}
		case 'boolean': {
			const low = text.toLowerCase();
			if (TRUE.has(low)) return { ok: true, value: true };
			if (FALSE.has(low)) return { ok: true, value: false };
			return { ok: false, error: `"${text}" is not true or false` };
		}
		case 'date':
			return Number.isNaN(new Date(text).getTime()) ? { ok: false, error: `"${text}" is not a date (e.g. 2026-10-26 or 2026-10-26T14:00:00Z)` } : { ok: true, value: text };
		case 'json':
			try {
				return { ok: true, value: JSON.parse(text) };
			} catch {
				return { ok: false, error: 'not valid JSON (text needs quotes: "like this")' };
			}
	}
}

/** A cell's text in the grid. */
export function formatCell(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

/** A cell's text in the editor: what `parseValue` turns back into the same value. */
export function editText(value: unknown, type: ColumnType): string {
	if (value === undefined || value === null) return '';
	if (type === 'json') return JSON.stringify(value);
	return formatCell(value);
}

export type GridColumn = { name: string; type: ColumnType; column?: TableColumn };

/** The grid's columns: the schema's columns in order, then other fields seen in the rows. */
export function gridColumns(schema: TableSchema | undefined, rows: readonly TableRecord[]): GridColumn[] {
	const out: GridColumn[] = (schema?.columns ?? []).map((c) => ({ name: c.name, type: c.type, column: c }));
	const seen = new Set(out.map((c) => c.name));
	for (const r of rows) {
		for (const [k, v] of Object.entries(r.data)) {
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ name: k, type: inferType(v) });
		}
	}
	return out;
}

/** The type to edit a cell with: the column's, else what the current value looks like. */
export function cellType(col: GridColumn, value: unknown): ColumnType {
	return col.column ? col.column.type : value === undefined || value === null ? col.type : inferType(value);
}

// ---------------------------------------------------------------- sorting

/** Header clicks cycle a field: ascending, descending, back to creation order. */
export function nextSort(current: Sort, field: string): Sort {
	if (!current || current.field !== field) return { field, dir: 1 };
	if (current.dir === 1) return { field, dir: -1 };
	return null;
}

/** The `sort` of a query, or undefined for creation order. */
export function sortBody(sort: Sort): Record<string, 1 | -1> | undefined {
	return sort ? { [sort.field]: sort.dir } : undefined;
}

// ---------------------------------------------------------------- filters

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'exists' | 'missing';

export const FILTER_OPS: readonly { id: FilterOp; label: string }[] = [
	{ id: 'eq', label: '=' },
	{ id: 'ne', label: '≠' },
	{ id: 'gt', label: '>' },
	{ id: 'gte', label: '≥' },
	{ id: 'lt', label: '<' },
	{ id: 'lte', label: '≤' },
	{ id: 'contains', label: 'contains' },
	{ id: 'startsWith', label: 'starts with' },
	{ id: 'exists', label: 'exists' },
	{ id: 'missing', label: 'is missing' }
];

/** Operators that take no value. */
export const takesValue = (op: FilterOp): boolean => op !== 'exists' && op !== 'missing';

export type Condition = { field: string; op: FilterOp; value: string };

/** A filter value for a field without a known type: true/false, null, numbers, else text. */
export function literal(text: string): unknown {
	const t = text.trim();
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (t === 'null') return null;
	if (t !== '' && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
	return text;
}

const typeOfField = (field: string, types: Record<string, ColumnType>): ColumnType | undefined =>
	field === '_version' || field === '_createdAt' || field === '_updatedAt' ? 'number' : field === '_id' ? 'string' : types[field];

/**
 * The builder's conditions as one filter, combined with AND. Values follow the field's column
 * type (`types`, by field name); other fields guess (numbers, true/false). Rows without a field
 * are skipped; a value that does not fit the column type is an error.
 */
export function buildFilter(conds: readonly Condition[], types: Record<string, ColumnType> = {}): { ok: true; filter: Filter | undefined } | { ok: false; error: string } {
	const parts: Filter[] = [];
	for (const c of conds) {
		const field = c.field.trim();
		if (!field) continue;
		if (c.op === 'exists' || c.op === 'missing') {
			parts.push({ [field]: { $exists: c.op === 'exists' } });
			continue;
		}
		let value: unknown;
		if (c.op === 'contains' || c.op === 'startsWith') value = c.value;
		else {
			const type = typeOfField(field, types);
			if (type === undefined || type === 'json') value = literal(c.value);
			else if (type === 'string' || type === 'date') value = c.value;
			else {
				const p = parseValue(c.value, type);
				if (!p.ok) return { ok: false, error: `${field}: ${p.error}` };
				value = 'unset' in p ? null : p.value;
			}
		}
		parts.push({ [field]: { [`$${c.op}`]: value } });
	}
	if (parts.length === 0) return { ok: true, filter: undefined };
	return { ok: true, filter: parts.length === 1 ? parts[0] : { $and: parts } };
}

/** A JSON object typed in a box (`what` names it in errors); empty is none. */
export function parseJsonObject(text: string, what = 'The filter'): { ok: true; filter: Filter | undefined } | { ok: false; error: string } {
	if (!text.trim()) return { ok: true, filter: undefined };
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: `${what} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `${what} must be a JSON object, like { "city": "Jakarta" }` };
	return { ok: true, filter: Object.keys(v).length ? (v as Filter) : undefined };
}

/** The "Advanced (JSON)" box of the filter: empty is no filter; otherwise a JSON object. */
export const parseJsonFilter = (text: string): ReturnType<typeof parseJsonObject> => parseJsonObject(text, 'The filter');

/** Both filters must match. */
export function combineFilters(...filters: (Filter | undefined)[]): Filter | undefined {
	const parts = filters.filter((f): f is Filter => !!f && Object.keys(f).length > 0);
	if (parts.length === 0) return undefined;
	return parts.length === 1 ? parts[0] : { $and: parts };
}

/** A filter on a set of row ids (delete the selected rows). */
export const idsFilter = (ids: readonly string[]): Filter => ({ _id: { $in: [...ids] } });

// ---------------------------------------------------------------- schema drafts

/** One column in the schema editor; `default` is the text typed for it. */
export type ColumnDraft = { name: string; type: ColumnType; required: boolean; indexed: boolean; default: string; description?: string };

export const emptyColumn = (): ColumnDraft => ({ name: '', type: 'string', required: false, indexed: false, default: '' });

export function draftOf(c: TableColumn): ColumnDraft {
	return {
		name: c.name,
		type: c.type,
		required: c.required === true,
		indexed: c.indexed === true,
		default: c.default === undefined ? '' : editText(c.default, c.type),
		...(c.description ? { description: c.description } : {})
	};
}

/**
 * The schema of the editor's drafts. Rows with an empty name are dropped; names, duplicates and
 * defaults are checked here so most mistakes show before the server is asked.
 */
export function schemaOf(drafts: readonly ColumnDraft[], strict: boolean): { ok: true; schema: TableSchema } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const columns: TableColumn[] = [];
	const seen = new Set<string>();
	for (const d of drafts) {
		const name = d.name.trim();
		if (!name) continue;
		if (!COLUMN_NAME.test(name)) errors.push(`"${name}" is not a column name: use letters, digits and _, starting with a letter`);
		else if (seen.has(name)) errors.push(`"${name}" is listed twice`);
		seen.add(name);
		const col: TableColumn = { name, type: d.type };
		if (d.required) col.required = true;
		if (d.indexed) col.indexed = true;
		if (d.description) col.description = d.description;
		if (d.default.trim() !== '' || (d.type === 'string' && d.default !== '')) {
			const p = parseValue(d.default, d.type);
			if (!p.ok) errors.push(`default of ${name}: ${p.error}`);
			else if (!('unset' in p)) col.default = p.value;
		}
		columns.push(col);
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, schema: strict ? { columns, strict: true } : { columns } };
}

/** A new row from form text by field: empty fields are left out. */
export function rowOf(values: Record<string, string>, cols: readonly GridColumn[]): { ok: true; row: Record<string, unknown> } | { ok: false; error: string } {
	const row: Record<string, unknown> = {};
	for (const c of cols) {
		const text = values[c.name] ?? '';
		const p = parseValue(text, c.type);
		if (!p.ok) return { ok: false, error: `${c.name}: ${p.error}` };
		if (!('unset' in p)) row[c.name] = p.value;
	}
	return { ok: true, row };
}

// ---------------------------------------------------------------- aggregates

export type MetricOp = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type MetricDraft = { op: MetricOp; field: string };

/** The result key of a metric: `count`, `sum_points`, `avg_customer_age`. */
export const metricName = (m: MetricDraft): string => (m.op === 'count' ? 'count' : `${m.op}_${m.field.replace(/[^A-Za-z0-9_]/g, '_')}`);

/** The aggregate request of the panel: up to 3 group fields, metrics with distinct names. */
export function aggregateOf(groupBy: readonly string[], metrics: readonly MetricDraft[], filter: Filter | undefined): { ok: true; body: TableAggregate } | { ok: false; error: string } {
	const groups = groupBy.map((g) => g.trim()).filter(Boolean);
	if (groups.length > 3) return { ok: false, error: 'Group by at most 3 fields' };
	const out: TableAggregate['metrics'] = {};
	for (const m of metrics) {
		if (m.op !== 'count' && !m.field.trim()) return { ok: false, error: `Pick a field for ${m.op}` };
		const name = metricName({ op: m.op, field: m.field.trim() });
		out[name] = m.op === 'count' ? { op: 'count' } : { op: m.op, field: m.field.trim() };
	}
	if (Object.keys(out).length === 0) out.count = { op: 'count' };
	return { ok: true, body: { ...(filter ? { filter } : {}), groupBy: groups, metrics: out, limit: 200 } };
}

// ---------------------------------------------------------------- files

export const defaultExportPath = (table: string): string => `/library/data/${table}.csv`;

/** The Files page showing a library file. */
export const filesHref = (path: string): string => `/files?path=${encodeURIComponent(path)}`;
