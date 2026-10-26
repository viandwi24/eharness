import { describe, expect, test } from 'bun:test';
import { blankCondition, conditionFilter, conditionsFilter, type Condition, describeCondition, filterConditions, literal, opsFor, retype, searchFilter, sortBody, sortBy, sortDir, splitList, takesValue } from './filters.js';

describe('operators', () => {
	test('per type, in plain words', () => {
		expect(opsFor('string').map((o) => o.label)).toContain('contains');
		expect(opsFor('boolean').map((o) => o.id)).toEqual(['isTrue', 'isFalse', 'empty', 'notEmpty']);
		expect(opsFor('date')[0]?.label).toBe('is on');
		expect(takesValue('empty')).toBe(false);
		expect(takesValue('is')).toBe(true);
		expect(blankCondition('due', 'date')).toEqual({ field: 'due', op: 'on', value: '' });
		expect(retype({ field: 'x', op: 'contains', value: 'a' }, 'number')).toEqual({ field: 'x', op: 'is', value: '' });
		expect(retype({ field: 'x', op: 'is', value: 'a' }, 'number')).toEqual({ field: 'x', op: 'is', value: 'a' });
	});
	test('literal and lists', () => {
		expect(literal('true')).toBe(true);
		expect(literal('-1.5')).toBe(-1.5);
		expect(literal('12abc')).toBe('12abc');
		expect(splitList(' a, ,b ,c')).toEqual(['a', 'b', 'c']);
	});
});

describe('condition → filter', () => {
	const ok = (c: Condition, t: Parameters<typeof conditionFilter>[1]) => {
		const r = conditionFilter(c, t);
		if (!r.ok) throw new Error(r.error);
		return r.filter;
	};
	test('text', () => {
		expect(ok({ field: 'city', op: 'is', value: 'Jakarta' }, 'string')).toEqual({ city: 'Jakarta' });
		expect(ok({ field: 'city', op: 'isNot', value: '10' }, 'string')).toEqual({ city: { $ne: '10' } });
		expect(ok({ field: 'n', op: 'contains', value: 'an' }, 'string')).toEqual({ n: { $contains: 'an' } });
		expect(ok({ field: 'n', op: 'notContains', value: 'an' }, 'string')).toEqual({ $not: { n: { $contains: 'an' } } });
		expect(ok({ field: 'n', op: 'startsWith', value: 'A' }, 'string')).toEqual({ n: { $startsWith: 'A' } });
		expect(ok({ field: 'n', op: 'anyOf', value: 'a, b' }, 'string')).toEqual({ n: { $in: ['a', 'b'] } });
		expect(ok({ field: 'n', op: 'noneOf', value: 'a' }, 'string')).toEqual({ n: { $nin: ['a'] } });
	});
	test('empty and checkboxes', () => {
		expect(ok({ field: 'n', op: 'empty', value: 'ignored' }, 'string')).toEqual({ n: { $in: [null, ''] } });
		expect(ok({ field: 'n', op: 'notEmpty', value: '' }, 'number')).toEqual({ n: { $nin: [null, ''] } });
		expect(ok({ field: 'vip', op: 'isTrue', value: '' }, 'boolean')).toEqual({ vip: true });
		expect(ok({ field: 'vip', op: 'isFalse', value: '' }, 'boolean')).toEqual({ vip: { $ne: true } });
	});
	test('numbers are checked', () => {
		expect(ok({ field: 'p', op: 'gte', value: '1_000' }, 'number')).toEqual({ p: { $gte: 1000 } });
		expect(ok({ field: 'p', op: 'is', value: '3' }, 'number')).toEqual({ p: 3 });
		expect(ok({ field: 'p', op: 'anyOf', value: '1,2' }, 'number')).toEqual({ p: { $in: [1, 2] } });
		expect(conditionFilter({ field: 'p', op: 'gt', value: 'x' }, 'number').ok).toBe(false);
		expect(conditionFilter({ field: 'p', op: 'gt', value: ' ' }, 'number').ok).toBe(false);
		expect(conditionFilter({ field: 'p', op: 'anyOf', value: '1, x' }, 'number').ok).toBe(false);
	});
	test('dates by whole days', () => {
		expect(ok({ field: 'd', op: 'on', value: '2026-10-26' }, 'date')).toEqual({ d: { $gte: '2026-10-26T00:00:00.000Z', $lte: '2026-10-26T23:59:59.999Z' } });
		expect(ok({ field: 'd', op: 'before', value: '2026-10-26' }, 'date')).toEqual({ d: { $lt: '2026-10-26T00:00:00.000Z' } });
		expect(ok({ field: 'd', op: 'after', value: '2026-10-26' }, 'date')).toEqual({ d: { $gt: '2026-10-26T23:59:59.999Z' } });
		expect(conditionFilter({ field: 'd', op: 'on', value: 'soon' }, 'date').ok).toBe(false);
	});
	test('json lists', () => {
		expect(ok({ field: 'tags', op: 'has', value: 'vip' }, 'json')).toEqual({ tags: { $has: 'vip' } });
		expect(ok({ field: 'tags', op: 'has', value: '3' }, 'json')).toEqual({ tags: { $has: 3 } });
	});
	test('combined with and / or; empty fields skipped', () => {
		expect(conditionsFilter([], {})).toEqual({ ok: true, filter: undefined });
		const conds: Condition[] = [
			{ field: 'a', op: 'is', value: 'x' },
			{ field: '', op: 'is', value: 'skipped' },
			{ field: 'b', op: 'gt', value: '2' }
		];
		expect(conditionsFilter(conds, { b: 'number' })).toEqual({ ok: true, filter: { $and: [{ a: 'x' }, { b: { $gt: 2 } }] } });
		expect(conditionsFilter(conds, { b: 'number' }, 'or')).toEqual({ ok: true, filter: { $or: [{ a: 'x' }, { b: { $gt: 2 } }] } });
		expect(conditionsFilter([conds[0] as Condition], {})).toEqual({ ok: true, filter: { a: 'x' } });
	});
});

describe('filter → conditions', () => {
	test('round-trips everything the builder makes', () => {
		const types = { s: 'string', n: 'number', d: 'date', b: 'boolean', j: 'json' } as const;
		const all: Condition[] = [
			{ field: 's', op: 'is', value: 'x' },
			{ field: 's', op: 'isNot', value: 'y' },
			{ field: 's', op: 'contains', value: 'an' },
			{ field: 's', op: 'notContains', value: 'zz' },
			{ field: 's', op: 'startsWith', value: 'A' },
			{ field: 's', op: 'anyOf', value: 'a, b' },
			{ field: 's', op: 'noneOf', value: 'c' },
			{ field: 's', op: 'empty', value: '' },
			{ field: 's', op: 'notEmpty', value: '' },
			{ field: 'n', op: 'gte', value: '10' },
			{ field: 'n', op: 'lt', value: '3' },
			{ field: 'd', op: 'on', value: '2026-01-02' },
			{ field: 'd', op: 'before', value: '2026-01-02' },
			{ field: 'd', op: 'after', value: '2026-01-02' },
			{ field: 'b', op: 'isTrue', value: '' },
			{ field: 'b', op: 'isFalse', value: '' },
			{ field: 'j', op: 'has', value: 'vip' }
		];
		for (const match of ['and', 'or'] as const) {
			const f = conditionsFilter(all, types, match);
			if (!f.ok) throw new Error(f.error);
			expect(filterConditions(f.filter)).toEqual({ match, conditions: all });
		}
	});
	test('top-level fields are an AND; others need the JSON tab', () => {
		expect(filterConditions(undefined)).toEqual({ match: 'and', conditions: [] });
		expect(filterConditions({ a: 1, b: { $gt: 2 } })).toEqual({
			match: 'and',
			conditions: [
				{ field: 'a', op: 'is', value: '1' },
				{ field: 'b', op: 'gt', value: '2' }
			]
		});
		expect(filterConditions({ $or: [{ a: 1 }, { $and: [{ b: 1 }] }] })).toBeNull();
		expect(filterConditions({ a: { $gt: 1, $lt: 5 } })).toBeNull();
		expect(filterConditions({ a: { $in: ['x,y'] } })).toBeNull();
		expect(filterConditions({ a: { tag: 1 } })).toBeNull();
	});
});

describe('chips, search and sort', () => {
	test('describe', () => {
		expect(describeCondition({ field: 'status', op: 'is', value: 'open' })).toBe('status is open');
		expect(describeCondition({ field: 'notes', op: 'empty', value: 'x' })).toBe('notes is empty');
		expect(describeCondition({ field: 'c', op: 'anyOf', value: 'a,b' }, 'City')).toBe('City is any of a, b');
		expect(describeCondition({ field: 'c', op: 'is', value: 'x'.repeat(50) }).length).toBeLessThan(50);
	});
	test('search', () => {
		expect(searchFilter('  ', ['a'])).toBeUndefined();
		expect(searchFilter('x', [])).toBeUndefined();
		expect(searchFilter('ann', ['name'])).toEqual({ name: { $contains: 'ann' } });
		expect(searchFilter(' ann ', ['name', 'email'])).toEqual({ $or: [{ name: { $contains: 'ann' } }, { email: { $contains: 'ann' } }] });
	});
	test('sort rules', () => {
		expect(sortBody([])).toBeUndefined();
		let r = sortBy([], 'a', 'asc');
		r = sortBy(r, 'b', 'desc');
		expect(r).toEqual([
			{ field: 'b', dir: 'desc' },
			{ field: 'a', dir: 'asc' }
		]);
		expect(sortBy(r, 'a', 'desc')).toEqual([
			{ field: 'a', dir: 'desc' },
			{ field: 'b', dir: 'desc' }
		]);
		expect(sortBy(sortBy(sortBy(r, 'c', 'asc'), 'd', 'asc'), 'e', 'asc')).toHaveLength(3);
		expect(sortDir(r, 'a')).toBe('asc');
		expect(sortDir(r, 'z')).toBeUndefined();
		expect(sortBody(r)).toEqual(r);
	});
});
