import { describe, expect, test } from 'bun:test';
import { confirmText, isLowDisk, percent, resultText, sizeText } from './model';

describe('storage model', () => {
	test('sizes', () => {
		expect(sizeText(0)).toBe('0 B');
		expect(sizeText(2048)).toBe('2.0 KB');
		expect(sizeText(150 * 1024 * 1024)).toBe('150 MB');
		expect(sizeText(null)).toBe('—');
	});
	test('percent', () => {
		expect(percent(25, 100)).toBe(25);
		expect(percent(1, 0)).toBe(0);
		expect(percent(500, 100)).toBe(100);
	});
	test('low disk follows the server rule', () => {
		const gb = 1024 ** 3;
		expect(isLowDisk({ totalBytes: 100 * gb, freeBytes: 9 * gb })).toBe(true);
		expect(isLowDisk({ totalBytes: 100 * gb, freeBytes: 40 * gb })).toBe(false);
		expect(isLowDisk({ totalBytes: 10 * gb, freeBytes: 1 * gb })).toBe(true);
	});
	test('result and confirmation texts', () => {
		const r = { message: 'Database compacted', before: { dbBytes: 3000, walBytes: 0, freeBytes: 1 }, after: { dbBytes: 1000, walBytes: 0, freeBytes: 1 } };
		expect(resultText(r)).toContain('freed 2.0 KB');
		expect(resultText({ ...r, after: r.before })).toContain('size unchanged');
		const s = { database: { dbBytes: 5 * 1024 * 1024 }, volume: { freeBytes: 1024 * 1024 * 1024 } } as Parameters<typeof confirmText>[1];
		expect(confirmText('compact', s)).toContain('5.0 MB');
		expect(confirmText('clear-media', s, 7)).toContain('7 days');
	});
});
