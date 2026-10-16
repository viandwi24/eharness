import { describe, expect, test } from 'bun:test';
import { previewText, sizeLabel } from './big.js';

describe('previewText', () => {
	test('small text is whole', () => {
		expect(previewText('abc')).toEqual({ big: false, shown: 'abc', hidden: 0 });
	});
	test('big text is cut to a preview and counts the rest', () => {
		const text = `${'line\n'.repeat(10_000)}`;
		const p = previewText(text);
		expect(p.big).toBe(true);
		expect(p.shown.length).toBeLessThanOrEqual(2000);
		expect(p.hidden + p.shown.length).toBe(text.length);
	});
});

describe('sizeLabel', () => {
	test('KB and MB', () => {
		expect(sizeLabel(250_000)).toBe('250 KB');
		expect(sizeLabel(1_800_000)).toBe('1.8 MB');
	});
});
