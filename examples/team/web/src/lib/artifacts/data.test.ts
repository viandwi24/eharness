import { describe, expect, test } from 'bun:test';
import { nextSort, parseCsv, toTable, view } from './data';

describe('csv', () => {
	test('quotes, escaped quotes, embedded newlines and crlf', () => {
		expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"l1\nl2",3\n')).toEqual([
			['a', 'b'],
			['x, y', 'say "hi"'],
			['l1\nl2', '3']
		]);
	});
	test('semicolon separated', () => {
		expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
	});
});

describe('toTable', () => {
	test('json array of objects unions the keys', () => {
		const t = toTable('[{"a":1},{"a":2,"b":"x"}]', 'x.json');
		expect(t?.columns).toEqual(['a', 'b']);
		expect(t?.rows).toEqual([['1', ''], ['2', 'x']]);
	});
	test('json that is not a table has none', () => {
		expect(toTable('{"a":1}', 'x.json')).toBeUndefined();
		expect(toTable('nope', 'x.json')).toBeUndefined();
	});
});

describe('view', () => {
	const rows = [['b', '10'], ['a', '9'], ['c', '100']];
	test('sorts numbers numerically and filters across cells', () => {
		expect(view(rows, '', { col: 1, dir: 'asc' }).map((r) => r[1])).toEqual(['9', '10', '100']);
		expect(view(rows, 'A', null)).toEqual([['a', '9']]);
	});
	test('header cycles asc, desc, off', () => {
		const a = nextSort(null, 0);
		expect(a).toEqual({ col: 0, dir: 'asc' });
		expect(nextSort(a, 0)).toEqual({ col: 0, dir: 'desc' });
		expect(nextSort(nextSort(a, 0), 0)).toBeNull();
	});
});
