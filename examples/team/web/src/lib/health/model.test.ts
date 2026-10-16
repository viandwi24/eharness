import { describe, expect, test } from 'bun:test';
import { type Finding, filterFindings, memoryWhere, seenLine, severityCounts, sortFindings, splitConsistency } from './model';

const f = (over: Partial<Finding>): Finding => ({
	fingerprint: 'x',
	kind: 'tool-loop',
	severity: 'medium',
	agentId: 'a1',
	agentName: 'Lead',
	sessionId: null,
	programId: null,
	programName: null,
	link: null,
	firstSeen: 1000,
	lastSeen: 2000,
	count: 5,
	explanation: 'e',
	fix: 'f',
	dismissed: false,
	dismissedAt: null,
	...over
});

describe('health model', () => {
	test('high severity first, then the newest', () => {
		const list = [f({ fingerprint: 'a', severity: 'medium', lastSeen: 9 }), f({ fingerprint: 'b', severity: 'high', lastSeen: 1 }), f({ fingerprint: 'c', severity: 'medium', lastSeen: 20 })];
		expect(sortFindings(list).map((x) => x.fingerprint)).toEqual(['b', 'c', 'a']);
	});
	test('filters by agent and severity; empty means all', () => {
		const list = [f({ agentId: 'a1' }), f({ agentId: 'a2', severity: 'high' })];
		expect(filterFindings(list, {})).toHaveLength(2);
		expect(filterFindings(list, { agentId: 'a2' })).toHaveLength(1);
		expect(filterFindings(list, { severity: 'high' })[0]?.agentId).toBe('a2');
		expect(filterFindings(list, { agentId: 'a1', severity: 'high' })).toHaveLength(0);
	});
	test('counts skip dismissed ones', () => {
		expect(severityCounts([f({}), f({ severity: 'high' }), f({ severity: 'high', dismissed: true })])).toEqual({ high: 1, medium: 1, low: 0 });
	});
	test('the evidence line', () => {
		const ago = (ms: number) => `${ms}s`;
		expect(seenLine(f({ count: 1, firstSeen: 5, lastSeen: 5 }), ago)).toBe('Seen once, 5s ago');
		expect(seenLine(f({ count: 4 }), ago)).toBe('Seen 4 times, first 1000s ago, last 2000s ago');
	});
	test('consistency findings are their own group, with the memory file and line', () => {
		const c = f({ fingerprint: 'c', kind: 'consistency', consistency: { kind: 'memory-dead-ref', memoryPath: 'status.md', line: 3, refs: ['status.md'] } });
		const g = splitConsistency([f({ fingerprint: 'r' }), c]);
		expect(g.runtime.map((x) => x.fingerprint)).toEqual(['r']);
		expect(g.consistency.map((x) => x.fingerprint)).toEqual(['c']);
		expect(memoryWhere(c)).toBe('status.md, line 3');
		expect(memoryWhere(f({}))).toBeNull();
	});
});
