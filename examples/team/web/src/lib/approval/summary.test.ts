import { describe, expect, test } from 'bun:test';
import { approvalHeadline, summarizeApproval } from './summary.js';

describe('summarizeApproval', () => {
	test('friendly title and one row per field', () => {
		const s = summarizeApproval('web_search', { query: 'svelte 5 runes', limit: 3 });
		expect(s.title).toBe('Search the web for svelte 5 runes');
		expect(s.rows).toEqual([
			{ label: 'Query', value: 'svelte 5 runes', mono: false },
			{ label: 'Limit', value: '3', mono: false }
		]);
		expect(JSON.parse(s.raw)).toEqual({ query: 'svelte 5 runes', limit: 3 });
	});

	test('commands and paths are monospace; empty values and long text are handled', () => {
		const s = summarizeApproval('bash', { command: 'ls -la', cwd: '', note: 'x'.repeat(500) });
		expect(s.rows[0]).toEqual({ label: 'Command', value: 'ls -la', mono: true });
		expect(s.rows).toHaveLength(2);
		expect(s.rows[1]!.value.length).toBe(401);
	});

	test('nested values become compact JSON; unknown tools keep their name; no input is fine', () => {
		expect(summarizeApproval('custom_tool', { opts: { a: 1 } }).rows[0]).toEqual({
			label: 'Opts',
			value: '{"a":1}',
			mono: false
		});
		expect(summarizeApproval('custom_tool', undefined)).toEqual({ title: 'custom_tool', rows: [], raw: '' });
		expect(summarizeApproval('x', 'plain').rows[0]!.value).toBe('plain');
	});
});

describe('approvalHeadline', () => {
	test('names the path, command or target in one line', () => {
		expect(approvalHeadline('bash', { command: 'rm -rf build' })).toBe('Command: rm -rf build');
		expect(approvalHeadline('write_file', { path: 'a/b.md', content: 'hello' })).toBe('Path: a/b.md (5 characters)');
		expect(approvalHeadline('send_message', { to: 'writer', content: 'x' })).toBe('To: writer');
	});
	test('keeps one line and ignores unreadable input', () => {
		expect(approvalHeadline('bash', { command: 'a\nb' })).toBe('Command: a …');
		expect(approvalHeadline('x', { n: 1 })).toBe('');
		expect(approvalHeadline('x', undefined)).toBe('');
	});
});
