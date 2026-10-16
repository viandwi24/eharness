import { describe, expect, test } from 'bun:test';
import { stepWindow } from './steps.js';

describe('stepWindow', () => {
	test('a short reply shows everything', () => {
		expect(stepWindow(30, 0)).toEqual({ start: 0, hidden: 0, next: 0 });
		expect(stepWindow(40, 0).hidden).toBe(0);
	});
	test('a long reply hides all but the newest 40', () => {
		expect(stepWindow(486, 0)).toEqual({ start: 446, hidden: 446, next: 100 });
	});
	test('revealing grows the window by chunks and stops at the first step', () => {
		expect(stepWindow(486, 100)).toEqual({ start: 346, hidden: 346, next: 100 });
		expect(stepWindow(486, 400).start).toBe(46);
		expect(stepWindow(486, 400).next).toBe(46);
		expect(stepWindow(486, 500)).toEqual({ start: 0, hidden: 0, next: 0 });
	});
	test('new steps keep the same revealed range at the tail', () => {
		expect(stepWindow(487, 100).start).toBe(347);
	});
});
