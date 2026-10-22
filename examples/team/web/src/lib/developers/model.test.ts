import { describe, expect, test } from 'bun:test';
import { chartDays, costText, curlSnippet, fetchSnippet, foldersOf, keyState, limitText, splitList, statusVariant, useChatSnippet } from './model';

describe('developers model', () => {
	test('splitList takes lines and commas, trims and dedupes', () => {
		expect(splitList(' https://a.example.com,\nhttps://b.example.com\n\nhttps://a.example.com ')).toEqual(['https://a.example.com', 'https://b.example.com']);
		expect(splitList('')).toEqual([]);
	});

	test('foldersOf lists folders below the library root, never the root, to a depth', () => {
		const paths = ['/library/public/cs/faq.md', '/library/public/cs/deep/a/b/c.md', '/library/readme.md', '/uploads/x.png', '/library/tickets/t1.md'];
		expect(foldersOf(paths)).toEqual(['/library/public', '/library/public/cs', '/library/public/cs/deep', '/library/tickets']);
		expect(foldersOf(paths, '/library', 1)).toEqual(['/library/public', '/library/tickets']);
	});

	test('status and cost text', () => {
		expect(statusVariant(0)).toBe('info');
		expect(statusVariant(200)).toBe('success');
		expect(statusVariant(429)).toBe('warning');
		expect(statusVariant(502)).toBe('destructive');
		expect(costText(0)).toBe('$0');
		expect(costText(0.0021)).toBe('$0.0021');
		expect(costText(1.5)).toBe('$1.50');
	});

	test('chartDays fills empty days', () => {
		const now = Date.UTC(2026, 0, 10, 12);
		const day = Date.UTC(2026, 0, 9);
		const out = chartDays([{ day, requests: 3, costUsd: 0.2 }], 3, now);
		expect(out.map((d) => d.requests)).toEqual([0, 3, 0]);
	});

	test('limits and key state', () => {
		expect(limitText({ dailyCostLimitUsd: 5, rateLimitPerMin: 60 })).toBe('$5.00 / day · 60 / min');
		expect(limitText({ dailyCostLimitUsd: null, rateLimitPerMin: null })).toBe('No limit');
		expect(keyState({ revokedAt: 1, expiresAt: null }, 10).label).toBe('Revoked');
		expect(keyState({ revokedAt: null, expiresAt: 5 }, 10).label).toBe('Expired');
		expect(keyState({ revokedAt: null, expiresAt: null }, 10).label).toBe('Active');
	});

	test('snippets name the route, the agent and a placeholder key', () => {
		const i = { baseUrl: 'https://team.example.com/api', agent: 'support-bot' };
		expect(curlSnippet('run', i)).toContain('https://team.example.com/api/v1/agents/support-bot/run');
		expect(curlSnippet('run', i)).toContain('Bearer ehk_your_key_here');
		expect(curlSnippet('conversation', { ...i, key: 'ehk_abcd1234_x' })).toContain('Bearer ehk_abcd1234_x');
		expect(fetchSnippet('run', { ...i, input: "it's" })).toContain('"it\'s"');
		expect(useChatSnippet(i)).toContain("baseUrl: 'https://team.example.com/api/v1'");
		expect(useChatSnippet(i)).toContain('createHarnessTransport');
	});

	test('curl quoting survives a single quote in the input', () => {
		const out = curlSnippet('run', { baseUrl: 'http://x', agent: 'a', input: "don't" });
		expect(out).toContain(`'{"input":"don'\\''t"}'`);
	});
});
