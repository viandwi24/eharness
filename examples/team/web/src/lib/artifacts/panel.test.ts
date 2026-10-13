import { describe, expect, test } from 'bun:test';
import { panelSearch, parsePanel } from './panel';

describe('panel url', () => {
	test('artifact, preview and file round-trip', () => {
		for (const t of [
			{ kind: 'artifact', id: 'art1', version: 2 },
			{ kind: 'preview', messageId: '0190-abc', index: 3 },
			{ kind: 'file', path: '/library/a b.png' }
		] as const) {
			expect(parsePanel(new URLSearchParams(panelSearch(new URLSearchParams(), t)))).toEqual(t);
		}
	});
	test('keeps other params and clears the panel', () => {
		const p = new URLSearchParams('t=abc&artifact=x');
		expect(panelSearch(p, null)).toBe('?t=abc');
		expect(parsePanel(new URLSearchParams('preview=bad'))).toBeNull();
		expect(parsePanel(new URLSearchParams('file=relative'))).toBeNull();
	});
});
