import { describe, expect, test } from 'bun:test';
import { pollWhileVisible } from './poll.js';

describe('pollWhileVisible', () => {
	test('polls only while visible and catches up when the page becomes visible', async () => {
		let visible = false;
		let calls = 0;
		let onChange = () => {};
		const stop = pollWhileVisible(() => calls++, 10, { visible: () => visible, listen: (cb) => ((onChange = cb), () => {}) });
		await new Promise((r) => setTimeout(r, 35));
		expect(calls).toBe(0);
		visible = true;
		onChange();
		expect(calls).toBe(1);
		await new Promise((r) => setTimeout(r, 35));
		expect(calls).toBeGreaterThan(1);
		stop();
		const after = calls;
		await new Promise((r) => setTimeout(r, 30));
		expect(calls).toBe(after);
	});
});
