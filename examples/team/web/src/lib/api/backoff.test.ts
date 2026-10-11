import { describe, expect, test } from 'bun:test';
import { createBackoff } from './backoff.js';

describe('createBackoff', () => {
	test('stays open below the threshold, then closes with a doubling, capped delay', () => {
		let t = 0;
		const b = createBackoff({ baseMs: 100, maxMs: 400, threshold: 2, now: () => t });
		b.failure();
		expect(b.tryAcquire()).toBe(true);
		b.failure(); // down: 100 ms
		expect(b.down).toBe(true);
		expect(b.tryAcquire()).toBe(false);
		t = 100;
		expect(b.tryAcquire()).toBe(true); // the probe
		expect(b.tryAcquire()).toBe(false); // the others wait for its answer
		b.failure(); // 200 ms
		expect(b.waitMs()).toBe(200);
		t = 300;
		expect(b.tryAcquire()).toBe(true);
		b.failure();
		b.failure();
		b.failure();
		expect(b.waitMs()).toBe(400); // capped
	});
	test('a success reopens and tells subscribers; reset opens the gate at once', () => {
		let t = 0;
		const b = createBackoff({ threshold: 1, now: () => t });
		const seen: boolean[] = [];
		b.subscribe((d) => seen.push(d));
		b.failure();
		expect(b.tryAcquire()).toBe(false);
		b.reset();
		expect(b.tryAcquire()).toBe(true);
		b.success();
		expect(seen).toEqual([true, false]);
		expect(b.tryAcquire()).toBe(true);
	});
});
