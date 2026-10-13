import { describe, expect, test } from 'bun:test';
import { isImagePath, parseSaved } from './saved';

describe('parseSaved', () => {
	test('reads the Saved line of a run_python result', () => {
		const out = 'done\nSaved: /library/work/a.png, /library/work/data.csv\n';
		expect(parseSaved(out)).toEqual(['/library/work/a.png', '/library/work/data.csv']);
	});
	test('accepts an object output, dedupes and ignores non-paths', () => {
		expect(parseSaved({ output: 'Saved: /library/a.svg, /library/a.svg, nothing' })).toEqual(['/library/a.svg']);
	});
	test('nothing saved', () => {
		expect(parseSaved('hello')).toEqual([]);
		expect(parseSaved(undefined)).toEqual([]);
	});
	test('image paths', () => {
		expect(isImagePath('/library/a.PNG')).toBe(true);
		expect(isImagePath('/library/a.html')).toBe(false);
	});
});
