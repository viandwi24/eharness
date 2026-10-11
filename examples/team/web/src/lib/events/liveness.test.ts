import { describe, expect, test } from 'bun:test';
import { backoffDelay, BACKOFF_MS, createLiveness } from './liveness';

describe('liveness', () => {
	test('connected until silence exceeds keep-alive + grace, then stale; closed is reconnecting', () => {
		const l = createLiveness();
		expect(l.health(0)).toBe('reconnecting');
		l.opened(1000);
		expect(l.health(1000 + 20_000)).toBe('connected');
		expect(l.health(1000 + 20_001)).toBe('stale');
		l.byte(30_000);
		expect(l.health(40_000)).toBe('connected');
		l.closed();
		expect(l.health(40_000)).toBe('reconnecting');
	});

	test('pings while busy every pingMs, only when stale otherwise', () => {
		const l = createLiveness();
		l.opened(0);
		expect(l.shouldPing(1000, false)).toBe(false);
		expect(l.shouldPing(1000, true)).toBe(true);
		l.pinged(1000);
		expect(l.shouldPing(4000, true)).toBe(false);
		expect(l.shouldPing(6000, true)).toBe(true);
		expect(l.shouldPing(30_000, false)).toBe(true); // stale
	});

	test('boot id: first, same, changed', () => {
		const l = createLiveness();
		expect(l.noteBoot('a')).toBe('first');
		expect(l.noteBoot('a')).toBe('same');
		expect(l.noteBoot('b')).toBe('changed');
		expect(l.noteBoot('b')).toBe('same');
		expect(l.boot).toBe('b');
	});

	test('backoff grows, is capped near 5 s and jitters down by at most half', () => {
		const max = (n: number): number => backoffDelay(n, BACKOFF_MS, () => 1);
		const min = (n: number): number => backoffDelay(n, BACKOFF_MS, () => 0);
		expect([1, 2, 3, 4, 5, 6].map(max)).toEqual([250, 500, 1000, 2000, 4000, 5000]);
		expect(max(40)).toBe(5000);
		expect(min(6)).toBe(2500);
		expect(max(0)).toBe(250);
	});
});
