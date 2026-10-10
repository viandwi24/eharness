import { describe, expect, test } from 'bun:test';
import { panelTabKey, readPref, writePref } from './prefs';

describe('prefs', () => {
	test('read and write never throw without storage', () => {
		expect(readPref('x')).toBeNull();
		expect(() => writePref('x', '1')).not.toThrow();
	});
	test('tab key is per agent', () => {
		expect(panelTabKey('a')).not.toBe(panelTabKey('b'));
	});
});
