import { describe, expect, test } from 'bun:test';
import { costAtThreshold, effectiveWindow, windowPresets, windowProblem } from './context-window';

describe('context window setting', () => {
	test('presets are only those below the model window', () => {
		expect(windowPresets(1_000_000)).toEqual([800_000, 500_000, 256_000, 128_000, 64_000]);
		expect(windowPresets(200_000)).toEqual([128_000, 64_000]);
		expect(windowPresets(32_000)).toEqual([]);
	});
	test('effective window is the smaller of custom and model', () => {
		expect(effectiveWindow(1_000_000, null)).toBe(1_000_000);
		expect(effectiveWindow(1_000_000, 256_000)).toBe(256_000);
		expect(effectiveWindow(32_000, 256_000)).toBe(32_000);
		expect(effectiveWindow(undefined, 256_000)).toBe(256_000);
	});
	test('validation', () => {
		expect(windowProblem(500_000, 1_000_000)).toBeUndefined();
		expect(windowProblem(1_000_001, 1_000_000)).toContain('Above');
		expect(windowProblem(10, 1_000_000)).toContain('At least');
	});
	test('cost at the threshold', () => {
		expect(costAtThreshold(1_000_000, 80, 3)).toBeCloseTo(2.4, 6);
		expect(costAtThreshold(1_000_000, 80, undefined)).toBeUndefined();
	});
});
