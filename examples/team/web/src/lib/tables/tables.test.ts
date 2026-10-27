import { describe, expect, test } from 'bun:test';
import {
	aggregateOf,
	combineFilters,
	defaultExportPath,
	draftOf,
	editText,
	filesHref,
	formatBytes,
	formatCell,
	formatOf,
	idsFilter,
	parseJsonFilter,
	parseValue,
	rowOf,
	schemaOf,
	withFormat
} from './tables.js';

describe('formatBytes', () => {
	test('scales units', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1023)).toBe('1023 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
		expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
		expect(formatBytes(undefined)).toBe('');
	});
});

describe('parseValue', () => {
	test('by column type', () => {
		expect(parseValue('hi ', 'string')).toEqual({ ok: true, value: 'hi ' });
		expect(parseValue(' 1_000.5 ', 'number')).toEqual({ ok: true, value: 1000.5 });
		expect(parseValue('abc', 'number').ok).toBe(false);
		expect(parseValue('Yes', 'boolean')).toEqual({ ok: true, value: true });
		expect(parseValue('0', 'boolean')).toEqual({ ok: true, value: false });
		expect(parseValue('maybe', 'boolean').ok).toBe(false);
		expect(parseValue('2026-10-26', 'date')).toEqual({ ok: true, value: '2026-10-26' });
		expect(parseValue('not a date', 'date').ok).toBe(false);
		expect(parseValue('{"a":[1]}', 'json')).toEqual({ ok: true, value: { a: [1] } });
		expect(parseValue('plain', 'json').ok).toBe(false);
	});
	test('empty means unset', () => {
		expect(parseValue('', 'string')).toEqual({ ok: true, unset: true });
		expect(parseValue('  ', 'number')).toEqual({ ok: true, unset: true });
	});
	test('editText round-trips', () => {
		for (const [v, t] of [
			[{ a: 1 }, 'json'],
			['text', 'json'],
			[42, 'number'],
			[false, 'boolean'],
			['x', 'string']
		] as const) {
			const p = parseValue(editText(v, t), t);
			expect(p.ok && 'value' in p ? p.value : undefined).toEqual(v);
		}
		expect(formatCell(null)).toBe('');
		expect(formatCell([1, 2])).toBe('[1,2]');
	});
});

describe('filters', () => {
	test('advanced JSON and combining', () => {
		expect(parseJsonFilter('')).toEqual({ ok: true, filter: undefined });
		expect(parseJsonFilter('{"a":1}')).toEqual({ ok: true, filter: { a: 1 } });
		expect(parseJsonFilter('[1]').ok).toBe(false);
		expect(parseJsonFilter('{a').ok).toBe(false);
		expect(combineFilters(undefined, {})).toBeUndefined();
		expect(combineFilters({ a: 1 }, undefined)).toEqual({ a: 1 });
		expect(combineFilters({ a: 1 }, { b: 2 })).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
		expect(idsFilter(['x', 'y'])).toEqual({ _id: { $in: ['x', 'y'] } });
	});
});

describe('schema drafts', () => {
	test('drafts become a schema; mistakes are listed', () => {
		const r = schemaOf(
			[
				{ name: 'name', type: 'string', required: true, indexed: false, default: '' },
				{ name: 'points', type: 'number', required: false, indexed: true, default: '0' },
				{ name: '', type: 'string', required: false, indexed: false, default: '' }
			],
			true
		);
		expect(r).toEqual({ ok: true, schema: { columns: [{ name: 'name', type: 'string', required: true }, { name: 'points', type: 'number', indexed: true, default: 0 }], strict: true } });
		const bad = schemaOf(
			[
				{ name: '1x', type: 'string', required: false, indexed: false, default: '' },
				{ name: 'a', type: 'number', required: false, indexed: false, default: 'z' },
				{ name: 'a', type: 'string', required: false, indexed: false, default: '' }
			],
			false
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors).toHaveLength(3);
	});
	test('draftOf round-trips a column', () => {
		const col = { name: 'tags', type: 'json' as const, default: ['a'], indexed: true };
		const r = schemaOf([draftOf(col)], false);
		expect(r).toEqual({ ok: true, schema: { columns: [col] } });
	});
	test('rowOf skips empty fields and reports bad ones', () => {
		const cols = [
			{ name: 'name', type: 'string' as const },
			{ name: 'points', type: 'number' as const },
			{ name: 'joined', type: 'date' as const }
		];
		expect(rowOf({ name: 'Ann', points: '3' }, cols)).toEqual({ ok: true, row: { name: 'Ann', points: 3 } });
		expect(rowOf({ points: 'x' }, cols).ok).toBe(false);
	});
});

describe('aggregates and files', () => {
	test('aggregate request', () => {
		expect(aggregateOf(['city', ''], [{ op: 'count', field: '' }, { op: 'sum', field: 'points' }], { a: 1 })).toEqual({
			ok: true,
			body: { filter: { a: 1 }, groupBy: ['city'], metrics: { count: { op: 'count' }, sum_points: { op: 'sum', field: 'points' } }, limit: 200 }
		});
		expect(aggregateOf([], [], undefined)).toEqual({ ok: true, body: { groupBy: [], metrics: { count: { op: 'count' } }, limit: 200 } });
		expect(aggregateOf(['a', 'b', 'c', 'd'], [], undefined).ok).toBe(false);
		expect(aggregateOf([], [{ op: 'avg', field: '' }], undefined).ok).toBe(false);
	});
	test('paths', () => {
		expect(defaultExportPath('members')).toBe('/library/data/members.csv');
		expect(filesHref('/library/data/a b.csv')).toBe('/files?path=%2Flibrary%2Fdata%2Fa%20b.csv');
	});
	test('formats by extension', () => {
		expect(formatOf('/a/b.CSV')).toBe('csv');
		expect(formatOf('x.jsonl')).toBe('ndjson');
		expect(formatOf('x.json')).toBe('json');
		expect(formatOf('x.txt')).toBeNull();
		expect(withFormat('/library/data/x.csv', 'json')).toBe('/library/data/x.json');
		expect(withFormat('/library/data/x', 'ndjson')).toBe('/library/data/x.ndjson');
	});
});

describe('unique fields', () => {
	test('a unique field is indexed too; json fields cannot be unique', () => {
		const ok = schemaOf([{ name: 'ref', type: 'string', required: false, indexed: false, unique: true, default: '' }], false);
		expect(ok).toEqual({ ok: true, schema: { columns: [{ name: 'ref', type: 'string', indexed: true, unique: true }] } });
		const bad = schemaOf([{ name: 'tags', type: 'json', required: false, indexed: false, unique: true, default: '' }], false);
		expect(bad.ok).toBe(false);
	});
});
