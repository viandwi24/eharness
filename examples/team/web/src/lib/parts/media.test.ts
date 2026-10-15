import { describe, expect, test } from 'bun:test';
import { toolContent, toolImages } from './media';

const ref = { type: 'media-ref', path: '/.eharness/tool-media/s-c1-1.png', version: 'v', mediaType: 'image/png', bytes: 9 };

describe('toolImages', () => {
	test('a media-ref output', () => {
		expect(toolImages({ type: 'media-ref', path: '/a.png', mediaType: 'image/png', text: 'x' })).toEqual([
			{ path: '/a.png', mediaType: 'image/png' }
		]);
	});
	test('an MCP result with an offloaded image reference', () => {
		const output = { content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', mimeType: 'image/png', ref }] };
		expect(toolImages(output)).toEqual([{ path: ref.path, mediaType: 'image/png' }]);
		expect(toolContent(output)).toEqual([
			{ kind: 'text', text: 'Screenshot' },
			{ kind: 'image', image: { path: ref.path, mediaType: 'image/png' } }
		]);
	});
	test('other outputs have no images', () => {
		expect(toolImages('text')).toEqual([]);
		expect(toolImages({ content: [{ type: 'text', text: 'a' }] })).toEqual([]);
		expect(toolImages({ content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] })).toEqual([]);
		expect(toolImages({ content: [{ type: 'audio', ref }] })).toEqual([]);
		expect(toolContent({ content: [{ type: 'text', text: 'a' }] })).toBeUndefined();
		expect(toolImages(null)).toEqual([]);
	});
});
