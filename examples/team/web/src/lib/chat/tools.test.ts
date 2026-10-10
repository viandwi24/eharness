/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { applySwitch, menuRows, offBadge, offIds, subtitle, withSwitch, type ChatTools } from './tools.ts';

const c = (id: string, name: string, over: Partial<ChatTools['connectors'][number]> = {}): ChatTools['connectors'][number] => ({
	connectionId: id,
	connectorId: id,
	name,
	label: name,
	source: 'curated',
	status: 'connected',
	on: true,
	tools: 3,
	...over
});
const state: ChatTools = { connectors: [c('github', 'GitHub'), c('web', 'Web', { on: false }), c('notion', 'Notion')], offCount: 1 };

describe('chat tools menu', () => {
	test('off ids and switches keep the other states', () => {
		expect(offIds(state)).toEqual(['web']);
		expect(withSwitch(state, 'github', false).sort()).toEqual(['github', 'web']);
		expect(withSwitch(state, 'web', true)).toEqual([]);
	});
	test('applySwitch recounts', () => {
		const next = applySwitch(state, 'github', false);
		expect(next.offCount).toBe(2);
		expect(next.connectors.find((x) => x.connectionId === 'github')?.on).toBe(false);
		expect(state.offCount).toBe(1); // not mutated
	});
	test('web search is its own row, others sorted by name', () => {
		const rows = menuRows(state);
		expect(rows.web.map((x) => x.connectionId)).toEqual(['web']);
		expect(rows.others.map((x) => x.name)).toEqual(['GitHub', 'Notion']);
	});
	test('badge only when something is off', () => {
		expect(offBadge(state)).toBe('1');
		expect(offBadge({ offCount: 0 })).toBeUndefined();
		expect(offBadge(undefined)).toBeUndefined();
	});
	test('subtitle: status first, then account, then a differing label', () => {
		expect(subtitle(c('a', 'GitHub', { status: 'needs-auth' }))).toBe('Needs sign-in');
		expect(subtitle(c('a', 'GitHub', { accountLabel: 'octocat' }))).toBe('octocat');
		expect(subtitle(c('a', 'GitHub', { label: 'work' }))).toBe('work');
		expect(subtitle(c('a', 'GitHub'))).toBe('');
	});
});
