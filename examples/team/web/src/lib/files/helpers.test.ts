import { describe, expect, test } from 'bun:test';
import { breadcrumbs, cleanPath, codeLanguage, fileKind, formatBytes, listFolder, parentOf, uploadTarget, type LibraryEntry } from './helpers';

const f = (path: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
	path, version: 'v', size: 1, mediaType: null, binary: false, createdByAgentId: null, createdBy: null, updatedAt: 1, ...extra
});

describe('file helpers', () => {
	test('kind by media type and extension', () => {
		expect(fileKind(f('/library/a.md', { mediaType: 'text/markdown' }))).toBe('markdown');
		expect(fileKind(f('/library/a.png', { mediaType: 'image/png', binary: true }))).toBe('image');
		expect(fileKind(f('/library/a.pdf', { binary: true }))).toBe('pdf');
		expect(fileKind(f('/library/a.ts'))).toBe('code');
		expect(fileKind(f('/library/a.txt'))).toBe('text');
		expect(fileKind(f('/library/a.svg', { mediaType: 'image/svg+xml' }))).toBe('text');
		expect(fileKind(f('/library/a.zip', { binary: true }))).toBe('other');
		expect(codeLanguage('/x/y.json')).toBe('json');
		expect(codeLanguage('/x/y.txt')).toBeNull();
	});

	test('formatBytes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
	});

	test('listFolder returns direct children with folder counts', () => {
		const all = [f('/library/a.md'), f('/library/r/b.md', { updatedAt: 5 }), f('/library/r/c/d.md', { updatedAt: 9 }), f('/uploads/x.png')];
		const root = listFolder(all, '/');
		expect(root.folders.map((x) => x.name)).toEqual(['library', 'uploads']);
		const lib = listFolder(all, '/library');
		expect(lib.files.map((x) => x.path)).toEqual(['/library/a.md']);
		expect(lib.folders).toEqual([{ name: 'r', path: '/library/r', count: 2, updatedAt: 9 }]);
		expect(listFolder(all, '/library/').files.length).toBe(1);
	});

	test('paths', () => {
		expect(parentOf('/library/a.md')).toBe('/library');
		expect(parentOf('/a.md')).toBe('/');
		expect(breadcrumbs('/library/r').map((b) => b.path)).toEqual(['/', '/library', '/library/r']);
		expect(cleanPath(' library//a.md ')).toBe('/library/a.md');
		expect(cleanPath('/library/../x')).toBeNull();
		expect(cleanPath('  ')).toBeNull();
	});
});

describe('uploadTarget', () => {
	const f = (name: string, type = '', size = 100) => ({ name, type, size });
	test('a text file goes into the open library folder', () => {
		expect(uploadTarget('/library/inbox', f('metrics.csv', 'text/csv'))).toEqual({ mode: 'folder', path: '/library/inbox/metrics.csv' });
		expect(uploadTarget('/library/', f('a.md'))).toEqual({ mode: 'folder', path: '/library/a.md' });
	});
	test('binary, large, empty files and other places use the uploads area', () => {
		expect(uploadTarget('/library/inbox', f('x.pdf', 'application/pdf'))).toEqual({ mode: 'uploads' });
		expect(uploadTarget('/library/inbox', f('big.txt', 'text/plain', 2_000_000))).toEqual({ mode: 'uploads' });
		expect(uploadTarget('/', f('a.txt', 'text/plain'))).toEqual({ mode: 'uploads' });
		expect(uploadTarget('/uploads/2026', f('a.txt', 'text/plain'))).toEqual({ mode: 'uploads' });
	});
});
