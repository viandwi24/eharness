import { describe, expect, test } from 'bun:test';
import {
	ariaSort,
	clampPage,
	initialParams,
	isFiltered,
	nextSort,
	pageWindow,
	paramsFromUrl,
	rangeText,
	searchOf,
	tableQuery,
	totalPages,
	yesNo
} from './table-core.js';

const D = { sort: 'lastSeen', order: 'desc' as const, limit: 25, filters: { kind: '', allowed: '' } };

describe('pages', () => {
	test('total pages and clamping', () => {
		expect(totalPages(0, 25)).toBe(1);
		expect(totalPages(26, 25)).toBe(2);
		expect(clampPage(9, 26, 25)).toBe(2);
		expect(clampPage(0, 26, 25)).toBe(1);
		expect(clampPage(Number.NaN, 26, 25)).toBe(1);
	});
	test('the range text', () => {
		expect(rangeText(1, 25, 132, 25)).toBe('1 to 25 of 132');
		expect(rangeText(6, 25, 132, 7)).toBe('126 to 132 of 132');
		expect(rangeText(1, 25, 0, 0)).toBe('No results');
	});
	test('the window keeps the first and last page and the neighbours of the current one', () => {
		expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
		expect(pageWindow(1, 20)).toEqual([1, 2, '…', 20]);
		expect(pageWindow(10, 20)).toEqual([1, '…', 9, 10, 11, '…', 20]);
		expect(pageWindow(20, 20)).toEqual([1, '…', 19, 20]);
	});
});

describe('sorting', () => {
	test('a new column starts in its first order, the same column flips', () => {
		expect(nextSort({ sort: 'lastSeen', order: 'desc' }, 'title')).toEqual({ sort: 'title', order: 'asc' });
		expect(nextSort({ sort: 'lastSeen', order: 'desc' }, 'lastSeen')).toEqual({ sort: 'lastSeen', order: 'asc' });
		expect(nextSort({ sort: 'title', order: 'asc' }, 'title')).toEqual({ sort: 'title', order: 'desc' });
		expect(nextSort({ sort: undefined, order: undefined }, 'lastSeen', 'desc')).toEqual({ sort: 'lastSeen', order: 'desc' });
	});
	test('aria-sort', () => {
		expect(ariaSort({ sort: 'a', order: 'desc' }, 'a')).toBe('descending');
		expect(ariaSort({ sort: 'a', order: 'asc' }, 'a')).toBe('ascending');
		expect(ariaSort({ sort: 'a', order: 'asc' }, 'b')).toBe('none');
	});
});

describe('the request query', () => {
	test('sends only what is set and merges the fixed part last', () => {
		const p = { ...initialParams(D), q: '  ops ', filters: { kind: 'group', allowed: '' } };
		expect(tableQuery(p, { level: 'chat' })).toEqual({ page: 1, limit: 25, q: 'ops', sort: 'lastSeen', order: 'desc', kind: 'group', level: 'chat' });
		expect(tableQuery(initialParams())).toEqual({ page: 1, limit: 25 });
	});
	test('yes/no values', () => {
		expect(yesNo('yes')).toBe('yes');
		expect(yesNo('')).toBeUndefined();
		expect(yesNo('maybe')).toBeUndefined();
	});
});

describe('the URL', () => {
	test('a default state has an empty query string', () => {
		expect(searchOf(initialParams(D), D)).toBe('');
	});
	test('round trip', () => {
		const p = { ...initialParams(D), q: 'a b', sort: 'title', order: 'asc' as const, page: 3, limit: 50, filters: { kind: 'group', allowed: '' } };
		const search = searchOf(p, D);
		expect(search).toBe('?q=a+b&sort=title&order=asc&page=3&limit=50&kind=group');
		expect(paramsFromUrl(new URLSearchParams(search), D)).toEqual(p);
	});
	test('garbage in the URL falls back to the defaults', () => {
		const p = paramsFromUrl(new URLSearchParams('sort=x;drop&order=up&page=-2&limit=7&kind=<b>'), D);
		expect(p).toEqual(initialParams(D));
	});
	test('is it filtered', () => {
		expect(isFiltered(initialParams(D), D)).toBe(false);
		expect(isFiltered({ ...initialParams(D), q: 'x' }, D)).toBe(true);
		expect(isFiltered({ ...initialParams(D), filters: { kind: 'group', allowed: '' } }, D)).toBe(true);
	});
});
