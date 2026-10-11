/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { uniqueById } from './messages.ts';

describe('uniqueById', () => {
	test('returns the same list when ids are unique', () => {
		const list = [{ id: 'a' }, { id: 'b' }];
		expect(uniqueById(list)).toBe(list);
	});
	test('keeps the last copy of a repeated id and reports it', () => {
		const seen: string[] = [];
		const out = uniqueById(
			[
				{ id: 'a', v: 1 },
				{ id: 'b', v: 1 },
				{ id: 'a', v: 2 }
			],
			(id) => seen.push(id)
		);
		expect(out).toEqual([
			{ id: 'b', v: 1 },
			{ id: 'a', v: 2 }
		]);
		expect(seen).toEqual(['a']);
	});
});
