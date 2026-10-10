import { describe, expect, test } from 'bun:test';
import {
	activeFilterCount,
	emptyFilters,
	filtersFromParams,
	formatDuration,
	matchesFilters,
	outputOf,
	paramsFromFilters,
	promptMessages,
	queryOf,
	tokensPerSecond,
	truncationOf
} from './logs';

describe('filters', () => {
	test('round trip through URL params, defaults omitted, junk ignored', () => {
		const f = { ...emptyFilters(), range: '7d' as const, sessionId: 'dm:a', kind: 'step', status: 'error' };
		const p = paramsFromFilters(f, 'abc');
		expect(p.toString()).toBe('range=7d&sessionId=dm%3Aa&kind=step&status=error&id=abc');
		expect(filtersFromParams(p)).toEqual(f);
		expect(paramsFromFilters(emptyFilters()).toString()).toBe('');
		expect(filtersFromParams(new URLSearchParams('range=9y&kind=zzz&status=bad'))).toEqual(emptyFilters());
		expect(activeFilterCount(f)).toBe(3);
	});

	test('queryOf anchors the range and drops empty filters', () => {
		expect(queryOf({ ...emptyFilters(), range: '1h', agentId: 'a1' }, 10_000_000)).toEqual({ from: 10_000_000 - 3_600_000, agentId: 'a1' });
	});

	test('live events match the view', () => {
		const e = { agentId: 'a1', sessionId: 'dm:a1', payload: { kind: 'step', status: 'ok', model: 'Anthropic/Claude' } };
		expect(matchesFilters(emptyFilters(), e)).toBe(true);
		expect(matchesFilters({ ...emptyFilters(), agentId: 'a2' }, e)).toBe(false);
		expect(matchesFilters({ ...emptyFilters(), status: 'error' }, e)).toBe(false);
		expect(matchesFilters({ ...emptyFilters(), model: 'claude' }, e)).toBe(true);
	});
});

describe('numbers', () => {
	test('speed counts generation time after the first chunk', () => {
		expect(tokensPerSecond({ outputTokens: 100, durationMs: 2000, firstChunkMs: 1000 })).toBe(100);
		expect(tokensPerSecond({ outputTokens: 100, durationMs: 2000, firstChunkMs: null })).toBe(50);
		expect(tokensPerSecond({ outputTokens: null, durationMs: 2000, firstChunkMs: 0 })).toBeNull();
		expect(tokensPerSecond({ outputTokens: 5, durationMs: 100, firstChunkMs: 100 })).toBeNull();
	});
	test('durations', () => {
		expect(formatDuration(250)).toBe('250ms');
		expect(formatDuration(1500)).toBe('1.50s');
		expect(formatDuration(125_000)).toBe('2m 5s');
		expect(formatDuration(null)).toBe('—');
	});
});

describe('payloads', () => {
	test('promptMessages normalizes string and part content', () => {
		const msgs = promptMessages({
			prompt: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'file', mediaType: 'image/png' }] },
				{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'grep', input: { q: 1 } }] },
				{ role: 'tool', content: [{ type: 'tool-result', toolName: 'grep', output: { type: 'text', value: 'found' } }] }
			]
		});
		expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
		expect(msgs[0]?.parts[0]).toEqual({ kind: 'text', text: 'Be brief.' });
		expect(msgs[1]?.parts[1]?.kind).toBe('file');
		expect(msgs[2]?.parts[0]).toMatchObject({ kind: 'tool-call', label: 'grep' });
		expect(msgs[3]?.parts[0]).toEqual({ kind: 'tool-result', label: 'grep', text: 'found' });
		expect(promptMessages(null)).toEqual([]);
		expect(promptMessages({ _truncated: true })).toEqual([]);
	});

	test('truncation marker and output view', () => {
		expect(truncationOf({ _truncated: true, bytes: 9, preview: '{"a"' })).toEqual({ bytes: 9, preview: '{"a"' });
		expect(truncationOf({ a: 1 })).toBeNull();
		expect(outputOf({ output: { text: 'x' } })).toEqual({ text: 'x', reasoning: '', toolCalls: [] });
	});
});
