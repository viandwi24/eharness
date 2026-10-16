import { describe, expect, test } from 'bun:test';
import { revealEarlier, windowStart } from './window.js';

const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);

describe('windowStart', () => {
	test('defaults to the newest 20', () => {
		expect(windowStart(ids, null)).toBe(30);
		expect(windowStart(ids.slice(0, 5), null)).toBe(0);
	});
	test('keeps the named start while messages are appended or prepended', () => {
		expect(windowStart([...ids, 'new'], 'm30')).toBe(30);
		expect(windowStart(['old', ...ids], 'm30')).toBe(31);
	});
	test('falls back to the newest window when the start id is gone', () => {
		expect(windowStart(ids, 'missing')).toBe(30);
	});
});

describe('revealEarlier', () => {
	test('moves the start back by one step, clamped to the first message', () => {
		expect(revealEarlier(ids, 30)).toBe('m10');
		expect(revealEarlier(ids, 10)).toBe('m0');
		expect(revealEarlier(ids, 0)).toBe('m0');
		expect(revealEarlier([], 0)).toBeNull();
	});
});
