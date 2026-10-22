import { describe, expect, test } from 'bun:test';
import { filesResultText, inFileMode, libraryLink, readyCount } from './files';

describe('program files', () => {
	test('counts what will move and words the outcome', () => {
		expect(readyCount([{ status: 'ready' }, { status: 'already' }, { status: 'blocked' }, { status: 'ready' }])).toBe(2);
		expect(filesResultText({ moved: 1, failed: [] })).toBe('1 program moved to the library.');
		expect(filesResultText({ moved: 2, failed: [{ programId: 'p', error: 'taken' }] })).toBe('2 programs moved to the library. 1 failed: taken.');
	});

	test('file mode follows the brief path', () => {
		expect(inFileMode({ briefPath: '/library/programs/x/brief.md' })).toBe(true);
		expect(inFileMode({ briefPath: null })).toBe(false);
		expect(libraryLink('/library/programs/a b/brief.md')).toBe('/files?path=%2Flibrary%2Fprograms%2Fa%20b%2Fbrief.md');
	});
});
