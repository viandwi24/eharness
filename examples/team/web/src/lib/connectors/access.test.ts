import { describe, expect, test } from 'bun:test';
import type { Agent, Connection } from '../api/client';
import { accessOf, accountName, accountsOfAgent, applyAccess, cardUsage, matchAgents, putFor, toggleAgent, usageText, usersOf } from './access';

const agent = (id: string, name: string): Agent => ({ id, slug: name.toLowerCase(), name }) as Agent;
const A = agent('a', 'Writer');
const B = agent('b', 'Coder');
const C = agent('c', 'Ops');
const agents = [A, B, C];
const conn = (over: Partial<Connection> = {}): Connection =>
	({ id: 'x', definitionId: 'mcp-remote', label: 'Docs C', scope: 'workspace', defaultEnabled: false, builtin: false, custom: true, ...over }) as Connection;

describe('access', () => {
	test('default access when the server did not describe it', () => {
		expect(accessOf(conn())).toEqual({ mode: 'selected', agentIds: [], excludedAgentIds: [] });
		expect(accessOf(conn({ scope: 'agent', scopeId: 'a' }))).toMatchObject({ mode: 'selected', agentIds: ['a'] });
		expect(accessOf(conn({ defaultEnabled: true })).mode).toBe('all');
	});

	test('usage texts', () => {
		expect(usageText(conn(), agents)).toBe('Not used by any agent yet');
		expect(usageText(conn({ access: { mode: 'selected', agentIds: ['a'], excludedAgentIds: [] } }), agents)).toBe('Writer');
		expect(usageText(conn({ access: { mode: 'selected', agentIds: ['a', 'b', 'c'], excludedAgentIds: [] } }), agents)).toBe('3 agents');
		expect(usageText(conn({ access: { mode: 'all', agentIds: ['a', 'c'], excludedAgentIds: ['b'] } }), agents)).toBe('All agents except 1');
		expect(usersOf(conn({ access: { mode: 'selected', agentIds: ['c', 'a', 'gone'], excludedAgentIds: [] } }), agents).map((a) => a.id)).toEqual(['a', 'c']);
	});

	test('card usage counts distinct agents', () => {
		const one = conn({ id: '1', access: { mode: 'selected', agentIds: ['a', 'b'], excludedAgentIds: [] } });
		const two = conn({ id: '2', access: { mode: 'selected', agentIds: ['b'], excludedAgentIds: [] } });
		expect(cardUsage([one, two], agents)).toBe('2 accounts · used by 2 agents');
		expect(cardUsage([conn()], agents)).toBe('1 account · not used yet');
	});

	test('by agent and names', () => {
		const one = conn({ id: '1', access: { mode: 'selected', agentIds: ['a'], excludedAgentIds: [] } });
		const builtin = conn({ id: '2', builtin: true, access: { mode: 'selected', agentIds: ['a'], excludedAgentIds: [] } });
		expect(accountsOfAgent('a', [one, builtin]).map((c) => c.id)).toEqual(['1']);
		expect(accountsOfAgent('b', [one])).toEqual([]);
		expect(accountName(conn({ label: 'Docs C' }), 'Custom')).toBe('Docs C');
		expect(accountName(conn({ custom: false, label: 'work', accountLabel: 'me' }), 'GitHub')).toBe('GitHub · work');
		expect(accountName(conn({ custom: false, label: 'GitHub', accountLabel: 'me' }), 'GitHub')).toBe('GitHub · me');
	});

	test('changes', () => {
		expect(putFor('all', ['a'])).toEqual({ mode: 'all' });
		expect(putFor('selected', ['a'])).toEqual({ mode: 'selected', agentIds: ['a'] });
		expect(toggleAgent(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggleAgent(['a', 'b'], 'a')).toEqual(['b']);
		const moved = applyAccess(conn({ scope: 'agent', scopeId: 'a' }), { mode: 'selected', agentIds: ['b', 'zzz'] }, ['a', 'b', 'c']);
		expect(moved).toMatchObject({ scope: 'workspace', defaultEnabled: false, access: { mode: 'selected', agentIds: ['b'] } });
		const all = applyAccess(conn({ access: { mode: 'all', agentIds: ['a', 'c'], excludedAgentIds: ['b'] }, defaultEnabled: true }), { mode: 'all' }, ['a', 'b', 'c']);
		expect(all.access).toEqual({ mode: 'all', agentIds: ['a', 'c'], excludedAgentIds: ['b'] });
	});

	test('search', () => {
		expect(matchAgents(agents, 'cod').map((a) => a.id)).toEqual(['b']);
		expect(matchAgents(agents, ' ')).toHaveLength(3);
	});
});
