import { describe, expect, test } from 'bun:test';
import { libraryPathOf } from './library-url.js';

describe('libraryPathOf', () => {
	test('decodes a library reference to its path', () => {
		expect(libraryPathOf('library:///uploads/2026-10-11/a%20b.png')).toBe('/uploads/2026-10-11/a b.png');
	});
	test('other and malformed urls have no library path', () => {
		expect(libraryPathOf('data:image/png;base64,AAAA')).toBeUndefined();
		expect(libraryPathOf('https://x.test/a.png')).toBeUndefined();
		expect(libraryPathOf('library:///uploads/%E0%A4%A')).toBeUndefined();
	});
});
