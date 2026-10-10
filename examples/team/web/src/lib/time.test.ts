import { describe, expect, test } from 'bun:test';
import { formatUsd, timeAgo } from './time';

describe('timeAgo', () => {
	const now = 1_000_000_000_000;
	test('buckets', () => {
		expect(timeAgo(now - 10_000, now)).toBe('now');
		expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
		expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h');
		expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
		expect(timeAgo(null, now)).toBe('');
	});
	test('usd', () => {
		expect(formatUsd(0.5)).toBe('$0.5000');
		expect(formatUsd(12)).toBe('$12.00');
	});
});
