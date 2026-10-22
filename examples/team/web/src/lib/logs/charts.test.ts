import { describe, expect, test } from 'bun:test';
import type { ModelCallStats } from '../api/client';
import {
	agentSlot,
	alignStart,
	bucketMsFor,
	cacheHitRate,
	costByAgentSeries,
	costBySourceSeries,
	deltaOf,
	errorRate,
	formatPercent,
	labelIndices,
	niceScale,
	sourceGroupOf,
	stackTotal,
	statusSeries,
	tokenSeries
} from './charts';
import { emptyFilters, filtersFromParams, paramsFromFilters, queryOf } from './logs';

type Bucket = ModelCallStats['buckets'][number];
const bucket = (over: Partial<Bucket> = {}): Bucket => ({
	start: 0,
	count: 0,
	errors: 0,
	aborted: 0,
	inputTokens: 0,
	outputTokens: 0,
	cachedTokens: 0,
	reasoningTokens: 0,
	costUsd: 0,
	costBySource: {},
	costByAgent: {},
	...over
});

describe('bucket width', () => {
	test('adapts to the range: minutes, hours, 6 hours, days', () => {
		expect(bucketMsFor('1h')).toBe(60_000);
		expect(bucketMsFor('24h')).toBe(3_600_000);
		expect(bucketMsFor('7d')).toBe(6 * 3_600_000);
		expect(bucketMsFor('30d')).toBe(86_400_000);
	});
	test('every preset stays within the server cap of 200 buckets', () => {
		const ranges = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
		for (const [id, ms] of Object.entries(ranges)) expect(ms / bucketMsFor(id as keyof typeof ranges)).toBeLessThanOrEqual(200);
	});
});

describe('bucket alignment', () => {
	test('hour buckets start on the hour, day buckets at local midnight', () => {
		const t = new Date(2026, 9, 22, 16, 25, 31).getTime();
		expect(alignStart(t, 3_600_000) % 3_600_000).toBe(0);
		expect(alignStart(t, 3_600_000)).toBeLessThanOrEqual(t);
		expect(alignStart(t, 3_600_000)).toBeGreaterThan(t - 3_600_000);
		expect(new Date(alignStart(t, 86_400_000)).getHours()).toBe(0);
		expect(alignStart(t, 86_400_000)).toBeLessThanOrEqual(t);
	});
});

describe('deltas', () => {
	test('percent change with a real minus sign', () => {
		expect(deltaOf(150, 100)).toEqual({ text: '+50%', dir: 'up' });
		expect(deltaOf(75, 100)).toEqual({ text: '−25%', dir: 'down' });
		expect(deltaOf(103, 100)).toEqual({ text: '+3.0%', dir: 'up' });
		expect(deltaOf(100, 100)).toEqual({ text: 'no change', dir: 'flat' });
	});
	test('nothing before is "new" (or no change when both are zero); unknown previous is null', () => {
		expect(deltaOf(5, 0)).toEqual({ text: 'new', dir: 'new' });
		expect(deltaOf(0, 0)).toEqual({ text: 'no change', dir: 'flat' });
		expect(deltaOf(5, null)).toBeNull();
	});
});

describe('rates', () => {
	test('cache hit rate and error rate are null without a denominator', () => {
		expect(cacheHitRate({ cachedTokens: 25, inputTokens: 100 })).toBe(0.25);
		expect(cacheHitRate({ cachedTokens: 0, inputTokens: 0 })).toBeNull();
		expect(errorRate({ errors: 1, count: 4 })).toBe(0.25);
		expect(errorRate({ errors: 0, count: 0 })).toBeNull();
		expect(formatPercent(0.25)).toBe('25%');
		expect(formatPercent(0.0123)).toBe('1.2%');
		expect(formatPercent(0.0001)).toBe('<0.1%');
		expect(formatPercent(null)).toBe('—');
	});
});

describe('colors by meaning', () => {
	test('sources keep their color; the small system sources share the neutral', () => {
		expect(sourceGroupOf('chat').slot).toBe('var(--viz-1)');
		expect(sourceGroupOf('compaction').slot).toBe('var(--viz-other)');
		expect(sourceGroupOf('classifier').id).toBe('system');
		expect(sourceGroupOf('unknown-future').id).toBe('system');
	});
	test('an agent keeps its slot by its place in the list; the 8th and beyond are neutral', () => {
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		expect(agentSlot(ids, 'a')).toBe('var(--viz-1)');
		expect(agentSlot(ids, 'g')).toBe('var(--viz-7)');
		expect(agentSlot(ids, 'h')).toBe('var(--viz-other)');
		expect(agentSlot(ids, null)).toBe('var(--viz-other)');
		expect(agentSlot(ids, 'zzz')).toBe('var(--viz-other)');
	});
	test('errors are the status red; a filter that removes a series does not repaint the others', () => {
		const b = [bucket({ count: 5, errors: 1, aborted: 1 })];
		const s = statusSeries(b);
		expect(s.find((x) => x.key === 'error')?.color).toBe('var(--viz-error)');
		expect(s.map((x) => x.values[0])).toEqual([3, 1, 1]);
		const all = costByAgentSeries([bucket({ costByAgent: { a: 1, b: 2 } })], ['a', 'b'], (id) => id);
		const only = costByAgentSeries([bucket({ costByAgent: { b: 2 } })], ['a', 'b'], (id) => id);
		expect(all.find((x) => x.key === 'b')?.color).toBe(only.find((x) => x.key === 'b')?.color);
	});
});

describe('series', () => {
	test('cost by source folds system sources into one group and drops empty groups', () => {
		const s = costBySourceSeries([bucket({ costBySource: { chat: 1, compaction: 0.25, flush: 0.25 } }), bucket({ costBySource: { chat: 2, heartbeat: 1 } })]);
		expect(s.map((x) => x.key)).toEqual(['chat', 'heartbeat', 'system']);
		expect(s.find((x) => x.key === 'system')?.values).toEqual([0.5, 0]);
		expect(stackTotal(s, 0)).toBe(1.5);
	});
	test('cost by agent folds agents beyond the 7 slots and calls without an agent into "Other agents"', () => {
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		const s = costByAgentSeries([bucket({ costByAgent: { a: 1, h: 2, none: 3 } })], ids, (id) => `Agent ${id}`);
		expect(s.map((x) => [x.label, x.values[0]])).toEqual([
			['Agent a', 1],
			['Other agents', 5]
		]);
	});
	test('tokens split input into cached and not cached so the stack adds up to input + output', () => {
		const [input, output, cached] = tokenSeries([bucket({ inputTokens: 100, cachedTokens: 40, outputTokens: 7 })]);
		expect([input?.values[0], output?.values[0], cached?.values[0]]).toEqual([60, 7, 40]);
	});
});

describe('axis', () => {
	test('niceScale covers the max with round gridlines', () => {
		expect(niceScale(0)).toEqual({ max: 1, lines: [0, 0.5, 1] });
		expect(niceScale(7)).toEqual({ max: 8, lines: [0, 2, 4, 6, 8] });
		expect(niceScale(0.43).max).toBeGreaterThanOrEqual(0.43);
		expect(niceScale(1234).lines.at(-1)).toBeGreaterThanOrEqual(1234);
	});
	test('label indices are evenly spread and bounded', () => {
		expect(labelIndices(0, 5)).toEqual([]);
		expect(labelIndices(3, 5)).toEqual([0, 1, 2]);
		const idx = labelIndices(168, 8);
		expect(idx.length).toBeLessThanOrEqual(8);
		expect(idx[0]).toBe(0);
	});
});

describe('source filter in the URL', () => {
	test('round trips; unknown sources are ignored; it reaches the API query', () => {
		const f = { ...emptyFilters(), source: 'heartbeat' };
		expect(paramsFromFilters(f).toString()).toBe('source=heartbeat');
		expect(filtersFromParams(new URLSearchParams('source=heartbeat')).source).toBe('heartbeat');
		expect(filtersFromParams(new URLSearchParams('source=nope')).source).toBe('');
		expect(queryOf(f, 1000).source).toBe('heartbeat');
	});
});

describe('cost axis', () => {
	test('round ticks without extra decimals', async () => {
		const { axisUsd } = await import('./charts');
		expect(axisUsd(0)).toBe('$0');
		expect(axisUsd(0.75)).toBe('$0.75');
		expect(axisUsd(1.5)).toBe('$1.50');
		expect(axisUsd(0.0025)).toBe('$0.0025');
	});
});
