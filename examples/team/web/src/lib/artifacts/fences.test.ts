import { describe, expect, test } from 'bun:test';
import { fenceIndexOf, fenceKind, previewFence, scanFences } from './fences';

const msg = (text: string) => ({ parts: [{ type: 'text', text }] });

describe('scanFences', () => {
	test('finds closed and open fences with their language', () => {
		const f = scanFences('Intro\n```mermaid\ngraph TD\nA-->B\n```\n\ntext\n```ts\nconst a = 1');
		expect(f).toHaveLength(2);
		expect(f[0]).toMatchObject({ index: 0, lang: 'mermaid', code: 'graph TD\nA-->B', closed: true });
		expect(f[1]).toMatchObject({ index: 1, lang: 'ts', closed: false });
	});
	test('a longer fence is not closed by a shorter one; tildes work', () => {
		const f = scanFences('````md\n```\ninner\n```\n````\n~~~svg\n<svg></svg>\n~~~');
		expect(f).toHaveLength(2);
		expect(f[0]?.code).toBe('```\ninner\n```');
		expect(f[1]).toMatchObject({ lang: 'svg', closed: true });
	});
	test('no fences', () => {
		expect(scanFences('just `inline` text')).toEqual([]);
	});
});

describe('fenceKind', () => {
	test('mermaid and svg fences', () => {
		expect(fenceKind({ lang: 'mermaid', code: 'pie' })).toBe('mermaid');
		expect(fenceKind({ lang: 'svg', code: '<svg/>' })).toBe('svg');
	});
	test('xml or no language is an svg only when the body starts with <svg', () => {
		expect(fenceKind({ lang: '', code: '\n<svg viewBox="0 0 1 1"></svg>' })).toBe('svg');
		expect(fenceKind({ lang: 'xml', code: '<?xml version="1.0"?>\n<svg xmlns="x"></svg>' })).toBe('svg');
		expect(fenceKind({ lang: 'xml', code: '<note>hi</note>' })).toBeUndefined();
		expect(fenceKind({ lang: '', code: 'echo hi' })).toBeUndefined();
	});
	test('html needs a document, a body or a script', () => {
		expect(fenceKind({ lang: 'html', code: '<!DOCTYPE html><html></html>' })).toBe('html');
		expect(fenceKind({ lang: 'html', code: '<body>x</body>' })).toBe('html');
		expect(fenceKind({ lang: 'html', code: '<script>1</script>' })).toBe('html');
		expect(fenceKind({ lang: 'html', code: '<div>snippet</div>' })).toBeUndefined();
	});
});

describe('previews', () => {
	test('previewFence returns closed previewable fences by index', () => {
		const m = msg('```js\nx\n```\n```mermaid\npie\n"a":1\n```\n```svg\n<svg>');
		expect(previewFence(m, 0)).toBeUndefined();
		expect(previewFence(m, 1)?.kind).toBe('mermaid');
		expect(previewFence(m, 2)).toBeUndefined(); // still open
	});
	test('fenceIndexOf matches by language and code, ignoring trailing newlines', () => {
		const f = scanFences('```js\na\n```\n```mermaid\npie\n```');
		expect(fenceIndexOf(f, 'mermaid', 'pie\n')).toBe(1);
		expect(fenceIndexOf(f, 'mermaid', 'other')).toBe(-1);
	});
});
