import { describe, expect, test } from 'bun:test';
import { collapseText } from './collapse.js';

describe('collapseText', () => {
	test('short text is shown whole', () => {
		expect(collapseText('hello')).toEqual({ collapsed: false, shown: 'hello', hidden: 0 });
		expect(collapseText('x'.repeat(2000)).collapsed).toBe(false);
	});
	test('long text keeps a preview cut at a word and counts what is hidden', () => {
		const text = `${'word '.repeat(600)}end`;
		const c = collapseText(text);
		expect(c.collapsed).toBe(true);
		expect(c.shown.length).toBeLessThanOrEqual(600);
		expect(c.shown.endsWith('word')).toBe(true);
		expect(c.hidden + c.shown.length).toBeGreaterThanOrEqual(text.length - 1);
	});
});
