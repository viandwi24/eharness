// The filter builder of the table view in plain words ("is", "contains", "is empty"), converted to
// and from the server's MongoDB-like filter, plus the search box and the sort rules. Pure: no
// Svelte, no fetch.
import { type ColumnType, type Filter, parseValue } from './tables.js';

export type FilterOp =
	| 'is'
	| 'isNot'
	| 'contains'
	| 'notContains'
	| 'startsWith'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'on'
	| 'before'
	| 'after'
	| 'isTrue'
	| 'isFalse'
	| 'anyOf'
	| 'noneOf'
	| 'has'
	| 'empty'
	| 'notEmpty';

/** One condition of the builder. `value` holds the text typed; `anyOf`/`noneOf` split it on commas. */
export type Condition = { field: string; op: FilterOp; value: string };
export type Match = 'and' | 'or';

const LABELS: Record<FilterOp, string> = {
	is: 'is',
	isNot: 'is not',
	contains: 'contains',
	notContains: 'does not contain',
	startsWith: 'starts with',
	gt: '>',
	gte: '≥',
	lt: '<',
	lte: '≤',
	on: 'is on',
	before: 'is before',
	after: 'is after',
	isTrue: 'is checked',
	isFalse: 'is not checked',
	anyOf: 'is any of',
	noneOf: 'is none of',
	has: 'has item',
	empty: 'is empty',
	notEmpty: 'is not empty'
};

export const opLabel = (op: FilterOp): string => LABELS[op];

const OPS_BY_TYPE: Record<ColumnType, FilterOp[]> = {
	string: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'anyOf', 'noneOf', 'empty', 'notEmpty'],
	number: ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'anyOf', 'empty', 'notEmpty'],
	date: ['on', 'before', 'after', 'empty', 'notEmpty'],
	boolean: ['isTrue', 'isFalse', 'empty', 'notEmpty'],
	json: ['has', 'contains', 'empty', 'notEmpty']
};

/** The operators offered for a field type, in menu order. */
export const opsFor = (type: ColumnType): { id: FilterOp; label: string }[] => OPS_BY_TYPE[type].map((id) => ({ id, label: LABELS[id] }));

/** Operators that take no value. */
export const takesValue = (op: FilterOp): boolean => !(op === 'empty' || op === 'notEmpty' || op === 'isTrue' || op === 'isFalse');

/** A fresh condition for a field: its type's first operator. */
export const blankCondition = (field: string, type: ColumnType): Condition => ({ field, op: OPS_BY_TYPE[type][0] as FilterOp, value: '' });

/** When the field changes, keep the operator if the new type offers it. */
export function retype(c: Condition, type: ColumnType): Condition {
	return OPS_BY_TYPE[type].includes(c.op) ? c : { ...c, op: OPS_BY_TYPE[type][0] as FilterOp, value: '' };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (day: string): string => `${day}T00:00:00.000Z`;
const dayEnd = (day: string): string => `${day}T23:59:59.999Z`;

/** A filter value for a field without a known type: true/false, numbers, else text. */
export function literal(text: string): unknown {
	const t = text.trim();
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (t !== '' && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
	return text;
}

/** Comma-separated values, trimmed, empty ones dropped. */
export const splitList = (text: string): string[] =>
	text
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

function scalarOf(text: string, type: ColumnType, field: string): { ok: true; value: unknown } | { ok: false; error: string } {
	if (type === 'number') {
		const p = parseValue(text, 'number');
		if (!p.ok) return { ok: false, error: `${field}: ${p.error}` };
		if ('unset' in p) return { ok: false, error: `${field}: type a number` };
		return { ok: true, value: p.value };
	}
	if (type === 'json') return { ok: true, value: literal(text) };
	return { ok: true, value: text };
}

/** One condition as a filter; `type` is the field's type. */
export function conditionFilter(c: Condition, type: ColumnType): { ok: true; filter: Filter } | { ok: false; error: string } {
	const f = c.field;
	const v = c.value;
	const need = (): string | null => (takesValue(c.op) && v.trim() === '' ? `${f}: type a value` : null);
	const missing = need();
	if (missing) return { ok: false, error: missing };
	switch (c.op) {
		case 'empty':
			return { ok: true, filter: { [f]: { $in: [null, ''] } } };
		case 'notEmpty':
			return { ok: true, filter: { [f]: { $nin: [null, ''] } } };
		case 'isTrue':
			return { ok: true, filter: { [f]: true } };
		case 'isFalse':
			return { ok: true, filter: { [f]: { $ne: true } } };
		case 'contains':
			return { ok: true, filter: { [f]: { $contains: v } } };
		case 'notContains':
			return { ok: true, filter: { $not: { [f]: { $contains: v } } } };
		case 'startsWith':
			return { ok: true, filter: { [f]: { $startsWith: v } } };
		case 'on':
		case 'before':
		case 'after': {
			const day = v.trim();
			if (!DAY.test(day)) return { ok: false, error: `${f}: pick a day` };
			if (c.op === 'on') return { ok: true, filter: { [f]: { $gte: dayStart(day), $lte: dayEnd(day) } } };
			return { ok: true, filter: { [f]: c.op === 'before' ? { $lt: dayStart(day) } : { $gt: dayEnd(day) } } };
		}
		case 'anyOf':
		case 'noneOf': {
			const items: unknown[] = [];
			for (const t of splitList(v)) {
				const s = scalarOf(t, type, f);
				if (!s.ok) return s;
				items.push(s.value);
			}
			if (!items.length) return { ok: false, error: `${f}: type one or more values, separated by commas` };
			return { ok: true, filter: { [f]: { [c.op === 'anyOf' ? '$in' : '$nin']: items } } };
		}
		case 'has':
			return { ok: true, filter: { [f]: { $has: literal(v) } } };
		default: {
			const s = scalarOf(v, type, f);
			if (!s.ok) return s;
			const op = { is: '$eq', isNot: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' }[c.op];
			return { ok: true, filter: c.op === 'is' ? { [f]: s.value } : { [f]: { [op]: s.value } } };
		}
	}
}

/** All conditions as one filter: every one must match (`and`) or any one (`or`). */
export function conditionsFilter(conds: readonly Condition[], types: Record<string, ColumnType>, match: Match = 'and'): { ok: true; filter: Filter | undefined } | { ok: false; error: string } {
	const parts: Filter[] = [];
	for (const c of conds) {
		if (!c.field) continue;
		const r = conditionFilter(c, types[c.field] ?? 'string');
		if (!r.ok) return r;
		parts.push(r.filter);
	}
	if (parts.length === 0) return { ok: true, filter: undefined };
	if (parts.length === 1) return { ok: true, filter: parts[0] };
	return { ok: true, filter: { [match === 'and' ? '$and' : '$or']: parts } };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const isEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.includes(null) && v.includes('');

/** One `{ field: condition }` (or `{ $not: { field: { $contains } } }`) back to a builder condition. */
function single(f: Filter): Condition | null {
	const keys = Object.keys(f);
	if (keys.length !== 1) return null;
	const key = keys[0] as string;
	const value = f[key];
	if (key === '$not') {
		if (!isPlain(value)) return null;
		const inner = single(value);
		return inner && inner.op === 'contains' ? { ...inner, op: 'notContains' } : null;
	}
	if (key.startsWith('$')) return null;
	if (!isPlain(value)) {
		if (value === true) return { field: key, op: 'isTrue', value: '' };
		const t = text(value);
		return t === null ? null : { field: key, op: 'is', value: t };
	}
	const ops = Object.keys(value);
	if (ops.length === 2 && typeof value.$gte === 'string' && typeof value.$lte === 'string') {
		const day = value.$gte.slice(0, 10);
		return value.$gte === dayStart(day) && value.$lte === dayEnd(day) ? { field: key, op: 'on', value: day } : null;
	}
	if (ops.length !== 1) return null;
	const op = ops[0] as string;
	const arg = value[op];
	switch (op) {
		case '$in':
		case '$nin': {
			if (!Array.isArray(arg)) return null;
			if (isEmptyList(arg)) return { field: key, op: op === '$in' ? 'empty' : 'notEmpty', value: '' };
			const items = arg.map(text);
			if (items.some((x) => x === null || x.includes(','))) return null;
			return { field: key, op: op === '$in' ? 'anyOf' : 'noneOf', value: items.join(', ') };
		}
		case '$ne':
			if (arg === true) return { field: key, op: 'isFalse', value: '' };
			break;
		case '$lt':
			if (typeof arg === 'string' && DAY.test(arg.slice(0, 10)) && arg === dayStart(arg.slice(0, 10))) return { field: key, op: 'before', value: arg.slice(0, 10) };
			break;
		case '$gt':
			if (typeof arg === 'string' && DAY.test(arg.slice(0, 10)) && arg === dayEnd(arg.slice(0, 10))) return { field: key, op: 'after', value: arg.slice(0, 10) };
			break;
	}
	const named: Record<string, FilterOp> = { $eq: 'is', $ne: 'isNot', $gt: 'gt', $gte: 'gte', $lt: 'lt', $lte: 'lte', $contains: 'contains', $startsWith: 'startsWith', $has: 'has' };
	const mapped = named[op];
	const t = text(arg);
	if (!mapped || t === null) return null;
	return { field: key, op: mapped, value: t };
}

/**
 * A filter back to builder conditions, when the builder can show it; null when it cannot (then
 * the "Advanced (JSON)" tab keeps it).
 */
export function filterConditions(filter: Filter | undefined): { match: Match; conditions: Condition[] } | null {
	if (!filter || Object.keys(filter).length === 0) return { match: 'and', conditions: [] };
	const keys = Object.keys(filter);
	if (keys.length === 1 && (keys[0] === '$and' || keys[0] === '$or')) {
		const list = filter[keys[0]];
		if (!Array.isArray(list)) return null;
		const conds: Condition[] = [];
		for (const part of list) {
			if (!isPlain(part)) return null;
			const c = single(part);
			if (!c) return null;
			conds.push(c);
		}
		return { match: keys[0] === '$and' ? 'and' : 'or', conditions: conds };
	}
	// several fields at the top level are an AND
	const conds: Condition[] = [];
	for (const k of keys) {
		const c = single({ [k]: filter[k] });
		if (!c) return null;
		conds.push(c);
	}
	return { match: 'and', conditions: conds };
}

/** A chip's text: `status is open`, `price > 10`, `notes is empty`. */
export function describeCondition(c: Condition, label: string = c.field): string {
	if (!takesValue(c.op)) return `${label} ${LABELS[c.op]}`;
	const v = c.op === 'anyOf' || c.op === 'noneOf' ? splitList(c.value).join(', ') : c.value;
	return `${label} ${LABELS[c.op]} ${v.length > 40 ? `${v.slice(0, 39)}…` : v}`;
}

/** The search box: text found (ignoring case) in any of `fields`, or undefined for no search. */
export function searchFilter(q: string, fields: readonly string[]): Filter | undefined {
	const t = q.trim();
	if (!t || fields.length === 0) return undefined;
	const parts = fields.slice(0, 40).map((f) => ({ [f]: { $contains: t } }));
	return parts.length === 1 ? parts[0] : { $or: parts };
}

// ---------------------------------------------------------------- sort rules

export type SortRule = { field: string; dir: 'asc' | 'desc' };

/** At most 3 rules, one per field: the server's limit. */
export const MAX_SORTS = 3;

/** The `sort` of a query, or undefined for creation order. */
export const sortBody = (rules: readonly SortRule[]): SortRule[] | undefined => (rules.length ? rules.slice(0, MAX_SORTS).map((r) => ({ field: r.field, dir: r.dir })) : undefined);

/** Sorting from a column menu: that field first (replacing its old rule), others kept after it. */
export function sortBy(rules: readonly SortRule[], field: string, dir: 'asc' | 'desc'): SortRule[] {
	return [{ field, dir }, ...rules.filter((r) => r.field !== field)].slice(0, MAX_SORTS);
}

/** Header arrow: the direction a field sorts in now, if it does. */
export const sortDir = (rules: readonly SortRule[], field: string): 'asc' | 'desc' | undefined => rules.find((r) => r.field === field)?.dir;
