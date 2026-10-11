import { describe, expect, test } from 'bun:test';
import { stripMarkdown } from './format.js';

describe('stripMarkdown', () => {
	test('removes emphasis, headings, bullets, links and code', () => {
		expect(stripMarkdown('**Created** `notes/a.md` with _two_ items')).toBe('Created notes/a.md with two items');
		expect(stripMarkdown('## Plan\n- first\n- see [the doc](https://x.y)')).toBe('Plan first see the doc');
		expect(stripMarkdown('before ```js\nx()\n``` after')).toBe('before after');
	});
	test('handles empty input', () => {
		expect(stripMarkdown(null)).toBe('');
		expect(stripMarkdown('  ')).toBe('');
	});
});
