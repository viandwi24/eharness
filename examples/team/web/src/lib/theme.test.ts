import { describe, expect, test } from 'bun:test';
import { modeCookie, resolveMode, savedMode } from './theme.js';

describe('theme mode', () => {
	test('a saved choice wins over the system', () => {
		expect(savedMode('a=1; edmi-mode=dark; b=2')).toBe('dark');
		expect(resolveMode('edmi-mode=light', true)).toBe('light');
		expect(resolveMode('edmi-mode=dark', false)).toBe('dark');
	});
	test('without one the system decides; junk is ignored', () => {
		expect(resolveMode('', true)).toBe('dark');
		expect(resolveMode('other=1', false)).toBe('light');
		expect(savedMode('edmi-mode=purple')).toBeUndefined();
	});
	test('the cookie lasts a year', () => {
		expect(modeCookie('dark')).toContain('edmi-mode=dark');
		expect(modeCookie('dark')).toContain('max-age=31536000');
	});
});
