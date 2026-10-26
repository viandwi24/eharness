import { describe, expect, test } from 'bun:test';
import { changedSince, DRAFT_ID, draftRecord, errorsByField, firstDraftField, isDraft, missingRequired, requiredErrors } from './draft.js';
import type { TableSchema } from './tables.js';

const schema: TableSchema = {
	columns: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'status', type: 'string', required: true, default: 'todo' },
		{ name: 'owner', type: 'string', required: true },
		{ name: 'points', type: 'number' }
	]
};

describe('draft rows', () => {
	test('record and id', () => {
		const r = draftRecord({ a: 1 });
		expect(r.id).toBe(DRAFT_ID);
		expect(isDraft(r)).toBe(true);
		expect(isDraft({ id: '01x' })).toBe(false);
	});
	test('missing required fields skip defaults and count empty text', () => {
		expect(missingRequired(schema, {})).toEqual(['title', 'owner']);
		expect(missingRequired(schema, { title: 'x', owner: '' })).toEqual(['owner']);
		expect(missingRequired(schema, { title: 'x', owner: 'ann' })).toEqual([]);
		expect(missingRequired(undefined, {})).toEqual([]);
		expect(requiredErrors(['owner'])).toEqual({ owner: 'owner is required: type a value to save the new row' });
	});
	test('first field to type into', () => {
		expect(firstDraftField(schema, ['points', 'title', 'owner'])).toBe('title');
		expect(firstDraftField(schema, ['points', 'owner'], { title: 'x' })).toBe('owner');
		expect(firstDraftField(schema, ['points'])).toBe('points');
		expect(firstDraftField({ columns: [] }, [])).toBeUndefined();
	});
	test('server errors onto cells', () => {
		expect(errorsByField('"title" is required; "points" must be a number', ['title', 'points'])).toEqual({ title: '"title" is required', points: '"points" must be a number' });
		expect(errorsByField('the row is too big', ['title'], 'title')).toEqual({ title: 'the row is too big' });
		expect(errorsByField('"zzz" is not a column', ['title'])).toEqual({});
	});
	test('changes made while the row was being created', () => {
		expect(changedSince({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual({ set: { b: 3, c: 4 }, unset: [] });
		expect(changedSince({ a: 1 }, {})).toEqual({ set: {}, unset: ['a'] });
	});
});
