import { describe, expect, test } from 'bun:test';
import {
	afterCommit,
	cellType,
	cellValue,
	discoverColumns,
	displayCell,
	editKey,
	formatDateValue,
	fromDateInput,
	gridKey,
	isVisible,
	isWholeDay,
	jsonPreview,
	moveFor,
	parsePrefs,
	queryable,
	searchFields,
	setVisible,
	tabMove,
	toDateInput
} from './grid.js';
import type { TableRecord } from './tables.js';

const rec = (id: string, data: Record<string, unknown>): TableRecord => ({ id, data, version: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, createdBy: 'ann', updatedBy: 'bob' });

describe('columns', () => {
	test('schema first, then extra fields, then system columns', () => {
		const cols = discoverColumns({ columns: [{ name: 'name', type: 'string' }, { name: 'points', type: 'number' }] }, [rec('1', { name: 'a', vip: true, note: null }), rec('2', { tags: ['x'], points: 3, vip: false, note: 'hi' })]);
		expect(cols.map((c) => [c.key, c.type, c.kind])).toEqual([
			['name', 'string', 'schema'],
			['points', 'number', 'schema'],
			['vip', 'boolean', 'extra'],
			['note', 'string', 'extra'],
			['tags', 'json', 'extra'],
			['@createdAt', 'date', 'system'],
			['@updatedAt', 'date', 'system'],
			['@by', 'string', 'system'],
			['@id', 'string', 'system']
		]);
		expect(cellType(cols[3] as never, 5)).toBe('number');
		expect(cellType(cols[0] as never, 5)).toBe('string');
		const r = rec('r1', { name: 'x' });
		expect(cellValue(r, cols[0] as never)).toBe('x');
		expect(cellValue(r, cols.at(-1) as never)).toBe('r1');
		expect(cellValue(r, cols.at(-2) as never)).toBe('bob');
		expect(cellValue(r, cols.at(-4) as never)).toBe(new Date(1_700_000_000_000).toISOString());
	});
	test('search and query fields', () => {
		const cols = discoverColumns({ columns: [{ name: 'name', type: 'string' }, { name: 'n', type: 'number' }] }, [rec('1', { 'First Name': 'a', city: 'b' })]);
		expect(searchFields(cols)).toEqual(['name', 'city']);
		expect(queryable(cols).map((c) => c.field)).toEqual(['name', 'n', 'city', '_createdAt', '_updatedAt', '_id']);
	});
	test('shown and hidden, remembered as prefs', () => {
		const cols = discoverColumns({ columns: [{ name: 'a', type: 'string' }] }, []);
		const a = cols[0] as never;
		const created = cols[1] as never;
		let p = parsePrefs(null);
		expect(isVisible(a, p)).toBe(true);
		expect(isVisible(created, p)).toBe(false);
		p = setVisible(p, a, false);
		p = setVisible(p, created, true);
		expect(isVisible(a, p)).toBe(false);
		expect(isVisible(created, p)).toBe(true);
		const again = parsePrefs(JSON.stringify(p));
		expect(again).toEqual(p);
		expect(setVisible(again, a, true).hidden).toEqual([]);
		expect(parsePrefs('{broken')).toEqual({ hidden: [], shown: [] });
		expect(parsePrefs('{"hidden":[1,"x"]}')).toEqual({ hidden: ['x'], shown: [] });
	});
});

describe('cells', () => {
	test('display by type', () => {
		expect(displayCell(undefined, 'string')).toBe('');
		expect(displayCell(1234.5, 'number')).toBe((1234.5).toLocaleString(undefined, { maximumFractionDigits: 6 }));
		expect(displayCell(true, 'boolean')).toBe('Yes');
		expect(displayCell(['a', 'b'], 'json')).toBe('2 items · a, b');
		expect(jsonPreview({ a: 1, b: 2, c: 3, d: 4 })).toBe('4 keys · a, b, c, …');
		expect(jsonPreview([])).toBe('0 items');
		expect(jsonPreview([{ x: 1 }, [1]])).toBe('2 items · {…}, […]');
	});
	test('dates', () => {
		expect(isWholeDay('2026-10-26T00:00:00.000Z')).toBe(true);
		expect(isWholeDay('2026-10-26')).toBe(true);
		expect(isWholeDay('2026-10-26T14:00:00.000Z')).toBe(false);
		expect(formatDateValue('2026-10-26T00:00:00.000Z', 'en-US')).toBe('Oct 26, 2026');
		expect(formatDateValue('nope')).toBe('nope');
		expect(toDateInput('2026-10-26T00:00:00.000Z')).toEqual({ mode: 'date', value: '2026-10-26' });
		expect(toDateInput(undefined)).toEqual({ mode: 'date', value: '' });
		const withTime = toDateInput('2026-10-26T14:05:00.000Z');
		expect(withTime.mode).toBe('datetime');
		expect(fromDateInput(withTime)).toBe('2026-10-26T14:05:00.000Z');
		expect(fromDateInput({ mode: 'date', value: '2026-10-26' })).toBe('2026-10-26');
		expect(fromDateInput({ mode: 'date', value: '' })).toBeNull();
	});
});

describe('keyboard', () => {
	const size = { rows: 3, cols: 4 };
	test('arrows clamp, Tab wraps', () => {
		expect(moveFor({ row: 0, col: 0 }, { key: 'ArrowUp' }, size)).toEqual({ row: 0, col: 0 });
		expect(moveFor({ row: 0, col: 0 }, { key: 'ArrowDown' }, size)).toEqual({ row: 1, col: 0 });
		expect(moveFor({ row: 1, col: 1 }, { key: 'ArrowRight', metaKey: true }, size)).toEqual({ row: 1, col: 3 });
		expect(moveFor({ row: 1, col: 1 }, { key: 'End', ctrlKey: true }, size)).toEqual({ row: 2, col: 3 });
		expect(moveFor({ row: 1, col: 1 }, { key: 'Home' }, size)).toEqual({ row: 1, col: 0 });
		expect(moveFor({ row: 0, col: 0 }, { key: 'PageDown' }, size)).toEqual({ row: 2, col: 0 });
		expect(moveFor({ row: 0, col: 0 }, { key: 'x' }, size)).toBeNull();
		expect(moveFor({ row: 0, col: 0 }, { key: 'ArrowDown' }, { rows: 0, cols: 2 })).toBeNull();
		expect(tabMove({ row: 0, col: 3 }, false, size)).toEqual({ row: 1, col: 0 });
		expect(tabMove({ row: 1, col: 0 }, true, size)).toEqual({ row: 0, col: 3 });
		expect(tabMove({ row: 2, col: 3 }, false, size)).toEqual({ row: 2, col: 3 });
	});
	test('grid keys', () => {
		const at = { row: 0, col: 0 };
		expect(gridKey(at, { key: 'Enter' }, size, 'string', true)).toEqual({ kind: 'edit' });
		expect(gridKey(at, { key: 'Enter' }, size, 'boolean', true)).toEqual({ kind: 'toggle' });
		expect(gridKey(at, { key: ' ' }, size, 'boolean', true)).toEqual({ kind: 'toggle' });
		expect(gridKey(at, { key: 'Enter', shiftKey: true }, size, 'string', true)).toEqual({ kind: 'expand' });
		expect(gridKey(at, { key: 'Delete' }, size, 'string', true)).toEqual({ kind: 'clear' });
		expect(gridKey(at, { key: 'Backspace' }, size, 'string', false)).toEqual({ kind: 'none' });
		expect(gridKey(at, { key: 'a' }, size, 'string', true)).toEqual({ kind: 'edit', text: 'a' });
		expect(gridKey(at, { key: 'a', metaKey: true }, size, 'string', true)).toEqual({ kind: 'none' });
		expect(gridKey(at, { key: 'a' }, size, 'json', true)).toEqual({ kind: 'none' });
		expect(gridKey(at, { key: 'ArrowRight' }, size, 'string', true)).toEqual({ kind: 'move', to: { row: 0, col: 1 } });
		expect(gridKey(at, { key: 'Enter' }, size, 'string', false)).toEqual({ kind: 'none' });
	});
	test('edit keys and where a commit goes', () => {
		expect(editKey({ key: 'Escape' })).toEqual({ kind: 'cancel' });
		expect(editKey({ key: 'Enter' })).toEqual({ kind: 'commit', then: 'down' });
		expect(editKey({ key: 'Enter' }, true)).toEqual({ kind: 'none' });
		expect(editKey({ key: 'Enter', metaKey: true }, true)).toEqual({ kind: 'commit', then: 'down' });
		expect(editKey({ key: 'Tab', shiftKey: true })).toEqual({ kind: 'commit', then: 'left' });
		expect(editKey({ key: 'a' })).toEqual({ kind: 'none' });
		expect(afterCommit({ row: 2, col: 1 }, 'down', size)).toEqual({ row: 2, col: 1 });
		expect(afterCommit({ row: 0, col: 3 }, 'right', size)).toEqual({ row: 1, col: 0 });
		expect(afterCommit({ row: 1, col: 1 }, 'stay', size)).toEqual({ row: 1, col: 1 });
	});
});
