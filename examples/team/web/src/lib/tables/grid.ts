// The spreadsheet grid of the table view: which columns it shows, how a cell reads and edits per
// type, and the keyboard (a reducer from a key to a move or an action). Pure: no Svelte, no DOM.
import { type ColumnType, inferType, type TableColumn, type TableRecord, type TableSchema } from './tables.js';

// ---------------------------------------------------------------- types in words

export const TYPE_LABELS: Record<ColumnType, string> = { string: 'Text', number: 'Number', boolean: 'Checkbox', date: 'Date', json: 'JSON' };
export const TYPE_HINTS: Record<ColumnType, string> = {
	string: 'Any text: names, emails, notes',
	number: 'Amounts, counts, scores',
	boolean: 'Yes or no, shown as a checkbox',
	date: 'A day, or a day and a time',
	json: 'Lists or nested data'
};

// ---------------------------------------------------------------- columns

/** `schema`: a column of the table's schema; `extra`: a field only seen in rows; `system`: kept by the table. */
export type ColumnKind = 'schema' | 'extra' | 'system';
export type SystemKey = 'createdAt' | 'updatedAt' | 'by' | 'id';

export type GridColumn = {
	/** Unique key: the field name, or `@createdAt`, `@updatedAt`, `@by`, `@id` for system columns. */
	key: string;
	/** The field a filter or a sort uses (`_createdAt` for Created); empty when it cannot be used. */
	field: string;
	label: string;
	type: ColumnType;
	kind: ColumnKind;
	column?: TableColumn;
	system?: SystemKey;
};

export const SYSTEM_COLUMNS: readonly GridColumn[] = [
	{ key: '@createdAt', field: '_createdAt', label: 'Created', type: 'date', kind: 'system', system: 'createdAt' },
	{ key: '@updatedAt', field: '_updatedAt', label: 'Updated', type: 'date', kind: 'system', system: 'updatedAt' },
	{ key: '@by', field: '', label: 'By', type: 'string', kind: 'system', system: 'by' },
	{ key: '@id', field: '_id', label: 'Row ID', type: 'string', kind: 'system', system: 'id' }
];

/**
 * Every column the grid can show: the schema's columns in order, then fields seen in the loaded
 * rows that the schema lacks (typed by their first value), then the system columns.
 */
export function discoverColumns(schema: TableSchema | undefined, rows: readonly TableRecord[]): GridColumn[] {
	const out: GridColumn[] = (schema?.columns ?? []).map((c) => ({ key: c.name, field: c.name, label: c.name, type: c.type, kind: 'schema', column: c }));
	const seen = new Set(out.map((c) => c.key));
	const firstValue = new Map<string, unknown>();
	const order: string[] = [];
	for (const r of rows) {
		for (const [k, v] of Object.entries(r.data)) {
			if (seen.has(k)) continue;
			if (!firstValue.has(k)) order.push(k);
			if (firstValue.get(k) === undefined || firstValue.get(k) === null) firstValue.set(k, v);
		}
	}
	for (const k of order) out.push({ key: k, field: k, label: k, type: inferType(firstValue.get(k)), kind: 'extra' });
	return [...out, ...SYSTEM_COLUMNS];
}

/** The value a column shows for a row. */
export function cellValue(row: TableRecord, col: GridColumn): unknown {
	switch (col.system) {
		case 'createdAt':
			return new Date(row.createdAt).toISOString();
		case 'updatedAt':
			return new Date(row.updatedAt).toISOString();
		case 'by':
			return row.updatedBy;
		case 'id':
			return row.id;
		default:
			return row.data[col.key];
	}
}

/** The type to edit a cell with: the column's, else what the current value looks like. */
export function cellType(col: GridColumn, value: unknown): ColumnType {
	if (col.kind !== 'extra') return col.type;
	return value === undefined || value === null ? col.type : inferType(value);
}

export const editable = (col: GridColumn): boolean => col.kind !== 'system';

/** Text fields the search box looks in. */
export const searchFields = (cols: readonly GridColumn[]): string[] => cols.filter((c) => c.kind !== 'system' && c.type === 'string' && FIELD_NAME.test(c.field)).map((c) => c.field);

/** Names a filter or sort accepts (a CSV header like "First Name" does not). */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Fields a filter, a sort or a group may use, with their types. */
export const queryable = (cols: readonly GridColumn[]): GridColumn[] => cols.filter((c) => c.field !== '' && (c.kind === 'system' || FIELD_NAME.test(c.field)));

/** Column width in px by type, so the grid looks even. */
export function columnWidth(col: GridColumn): number {
	if (col.system === 'id') return 130;
	if (col.system === 'by') return 140;
	return { string: 220, number: 130, boolean: 110, date: 170, json: 200 }[col.type];
}

// ---------------------------------------------------------------- shown and hidden columns

/** Per table, in localStorage: columns hidden by hand, and system columns shown by hand. */
export type ColumnPrefs = { hidden: string[]; shown: string[] };

export const prefsKey = (table: string): string => `tables.columns.${table}`;

export function parsePrefs(raw: string | null | undefined): ColumnPrefs {
	try {
		const v = raw ? (JSON.parse(raw) as unknown) : null;
		if (v && typeof v === 'object') {
			const o = v as { hidden?: unknown; shown?: unknown };
			const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
			return { hidden: strings(o.hidden), shown: strings(o.shown) };
		}
	} catch {
		// a broken value: start over
	}
	return { hidden: [], shown: [] };
}

/** System columns start hidden; everything else starts shown. */
export const isVisible = (col: GridColumn, prefs: ColumnPrefs): boolean => (col.kind === 'system' ? prefs.shown.includes(col.key) : !prefs.hidden.includes(col.key));

export function setVisible(prefs: ColumnPrefs, col: GridColumn, visible: boolean): ColumnPrefs {
	const without = (list: string[]): string[] => list.filter((k) => k !== col.key);
	if (col.kind === 'system') return { hidden: prefs.hidden, shown: visible ? [...without(prefs.shown), col.key] : without(prefs.shown) };
	return { hidden: visible ? without(prefs.hidden) : [...without(prefs.hidden), col.key], shown: prefs.shown };
}

// ---------------------------------------------------------------- reading cells

const MIDNIGHT = /T00:00:00(\.000)?Z$/;

/** A date value is a whole day when it is midnight UTC (how the server stores "2026-10-26"). */
export const isWholeDay = (iso: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(iso) || MIDNIGHT.test(iso);

/** A date for people: "Oct 26, 2026", or "Oct 26, 2026, 14:05" when it has a time. */
export function formatDateValue(value: unknown, locale?: string): string {
	if (typeof value !== 'string' && typeof value !== 'number') return '';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return String(value);
	if (typeof value === 'string' && isWholeDay(value)) return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
	return d.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A number for people: grouped digits, up to 6 decimals. */
export const formatNumber = (n: number, locale?: string): string => n.toLocaleString(locale, { maximumFractionDigits: 6 });

/** A short preview of a JSON value: `3 items · a, b, c` or `2 keys · name, age`. */
export function jsonPreview(value: unknown): string {
	if (Array.isArray(value)) {
		const head = value
			.slice(0, 3)
			.map((v) => (typeof v === 'object' && v !== null ? (Array.isArray(v) ? '[…]' : '{…}') : String(v)))
			.join(', ');
		return `${value.length} item${value.length === 1 ? '' : 's'}${value.length ? ` · ${head}${value.length > 3 ? ', …' : ''}` : ''}`;
	}
	if (typeof value === 'object' && value !== null) {
		const keys = Object.keys(value);
		return `${keys.length} key${keys.length === 1 ? '' : 's'}${keys.length ? ` · ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}` : ''}`;
	}
	return value === undefined ? '' : JSON.stringify(value);
}

/** A cell's text in the grid, by type. Empty for no value. */
export function displayCell(value: unknown, type: ColumnType): string {
	if (value === undefined || value === null) return '';
	if (type === 'date' && typeof value === 'string') return formatDateValue(value);
	if (typeof value === 'number') return formatNumber(value);
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (typeof value === 'string') return value;
	return jsonPreview(value);
}

/** The full value, for a tooltip or a copy. */
export function fullText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------- editing dates

export type DateInput = { mode: 'date' | 'datetime'; value: string };

const pad = (n: number): string => String(n).padStart(2, '0');

/** A stored date as the value of an `<input type="date">` (whole days) or `datetime-local`. */
export function toDateInput(value: unknown): DateInput {
	if (typeof value !== 'string' || value === '') return { mode: 'date', value: '' };
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return { mode: 'date', value: '' };
	if (isWholeDay(value)) return { mode: 'date', value: d.toISOString().slice(0, 10) };
	return { mode: 'datetime', value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** An input's value back to what the server stores: `2026-10-26` (a whole day) or an ISO time. */
export function fromDateInput(input: DateInput): string | null {
	if (!input.value) return null;
	if (input.mode === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : null;
	const d = new Date(input.value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- keyboard

export type Pos = { row: number; col: number };
export type Size = { rows: number; cols: number };

export type KeyLike = { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };

/**
 * What a key does in the grid when no cell is being edited:
 * - `move`: go to another cell; `edit`: start editing (`text` starts it with that character);
 * - `clear`: empty the cell; `toggle`: flip a checkbox; `expand`: open the row; `none`: ignore.
 */
export type GridAction = { kind: 'move'; to: Pos } | { kind: 'edit'; text?: string } | { kind: 'clear' } | { kind: 'toggle' } | { kind: 'expand' } | { kind: 'none' };

const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n));

/** Where the active cell goes for an arrow, Tab, Home/End or Page key; null for other keys. */
export function moveFor(pos: Pos, e: KeyLike, size: Size): Pos | null {
	if (size.rows === 0 || size.cols === 0) return null;
	const lastRow = size.rows - 1;
	const lastCol = size.cols - 1;
	const big = e.metaKey || e.ctrlKey;
	switch (e.key) {
		case 'ArrowUp':
			return { row: big ? 0 : clamp(pos.row - 1, lastRow), col: pos.col };
		case 'ArrowDown':
			return { row: big ? lastRow : clamp(pos.row + 1, lastRow), col: pos.col };
		case 'ArrowLeft':
			return { row: pos.row, col: big ? 0 : clamp(pos.col - 1, lastCol) };
		case 'ArrowRight':
			return { row: pos.row, col: big ? lastCol : clamp(pos.col + 1, lastCol) };
		case 'Home':
			return big ? { row: 0, col: 0 } : { row: pos.row, col: 0 };
		case 'End':
			return big ? { row: lastRow, col: lastCol } : { row: pos.row, col: lastCol };
		case 'PageUp':
			return { row: clamp(pos.row - 10, lastRow), col: pos.col };
		case 'PageDown':
			return { row: clamp(pos.row + 10, lastRow), col: pos.col };
		case 'Tab':
			return tabMove(pos, !!e.shiftKey, size);
		case 'Enter':
			return { row: clamp(pos.row + (e.shiftKey ? -1 : 1), lastRow), col: pos.col };
		default:
			return null;
	}
}

/** Tab goes right and wraps to the next row; Shift+Tab goes left and wraps up. */
export function tabMove(pos: Pos, back: boolean, size: Size): Pos {
	if (back) {
		if (pos.col > 0) return { row: pos.row, col: pos.col - 1 };
		return pos.row > 0 ? { row: pos.row - 1, col: size.cols - 1 } : pos;
	}
	if (pos.col < size.cols - 1) return { row: pos.row, col: pos.col + 1 };
	return pos.row < size.rows - 1 ? { row: pos.row + 1, col: 0 } : pos;
}

/** The grid's keyboard when no cell is being edited. `type` is the active cell's type. */
export function gridKey(pos: Pos, e: KeyLike, size: Size, type: ColumnType, canEdit: boolean): GridAction {
	if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
		if (!canEdit) return { kind: 'none' };
		return type === 'boolean' ? { kind: 'toggle' } : { kind: 'edit' };
	}
	if (e.key === 'Enter' && e.shiftKey) return { kind: 'expand' };
	if (e.key === 'F2') return canEdit && type !== 'boolean' ? { kind: 'edit' } : { kind: 'none' };
	if (e.key === ' ' && type === 'boolean') return canEdit ? { kind: 'toggle' } : { kind: 'none' };
	if (e.key === 'Delete' || e.key === 'Backspace') return canEdit ? { kind: 'clear' } : { kind: 'none' };
	const to = moveFor(pos, e, size);
	if (to) return { kind: 'move', to };
	// typing a character starts editing with it, like a spreadsheet
	if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && canEdit && type !== 'boolean' && type !== 'json') return { kind: 'edit', text: e.key };
	return { kind: 'none' };
}

/** While editing: Enter / Tab commit and move, Escape cancels. */
export type EditAction = { kind: 'commit'; then: 'down' | 'up' | 'right' | 'left' | 'stay' } | { kind: 'cancel' } | { kind: 'none' };

export function editKey(e: KeyLike, multiline = false): EditAction {
	if (e.key === 'Escape') return { kind: 'cancel' };
	if (e.key === 'Tab') return { kind: 'commit', then: e.shiftKey ? 'left' : 'right' };
	if (e.key === 'Enter') {
		if (multiline && !(e.metaKey || e.ctrlKey)) return { kind: 'none' };
		if (e.altKey) return { kind: 'none' };
		return { kind: 'commit', then: e.shiftKey ? 'up' : 'down' };
	}
	return { kind: 'none' };
}

/** The cell after a commit. */
export function afterCommit(pos: Pos, then: Extract<EditAction, { kind: 'commit' }>['then'], size: Size): Pos {
	switch (then) {
		case 'down':
			return { row: clamp(pos.row + 1, size.rows - 1), col: pos.col };
		case 'up':
			return { row: clamp(pos.row - 1, size.rows - 1), col: pos.col };
		case 'right':
			return tabMove(pos, false, size);
		case 'left':
			return tabMove(pos, true, size);
		default:
			return pos;
	}
}

/** How a save went: `stale` means the row changed meanwhile and was reloaded (keep what was typed). */
export type SaveResult = 'ok' | 'error' | 'stale';
