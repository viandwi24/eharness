import { describe, expect, test } from 'bun:test';
import type { AgentConnector } from '../api/client';
import { applyChoices, choicesOf, groupConnectors, originLabel, scopeBadge, withCapabilityMode, withEnabled, withToolMode } from './agent-view';

const conn = (over: Partial<AgentConnector> = {}): AgentConnector =>
	({
		connectionId: 'c1',
		connectorId: 'github',
		name: 'GitHub',
		category: 'development',
		source: 'curated',
		label: 'Work',
		status: 'connected',
		scope: 'workspace',
		ownership: 'workspace',
		defaultEnabled: true,
		state: 'inherit',
		enabled: true,
		capabilities: [
			{ id: 'read', title: 'Read', description: '', kind: 'read', tools: ['get'], defaultMode: 'allow', mode: 'allow', inherited: 'allow', pinned: false, toolModes: [{ name: 'get', mode: 'allow' }] },
			{ id: 'write', title: 'Write', description: '', kind: 'write', tools: ['put'], defaultMode: 'ask', mode: 'off', inherited: 'ask', override: 'off', pinned: true, toolModes: [{ name: 'put', mode: 'ask', override: 'ask' }] }
		],
		...over
	}) as AgentConnector;

describe('agent-view', () => {
	test('labels and grouping', () => {
		expect(originLabel(conn())).toBe('From workspace');
		expect(originLabel(conn({ ownership: 'agent' }))).toBe('This agent only');
		expect(scopeBadge(conn({ source: 'builtin' }))).toBe('Whole team');
		expect(scopeBadge(conn({ source: 'builtin', ownership: 'agent' }))).toBe('Only this agent');
		const g = groupConnectors([conn({ source: 'builtin' }), conn()]);
		expect(g.builtin.length).toBe(1);
		expect(g.connected.length).toBe(1);
	});

	test('choicesOf keeps overrides, omits inherit', () => {
		expect(choicesOf(conn())).toEqual({ capabilities: { write: 'off' }, tools: { put: 'ask' } });
		expect(choicesOf(conn({ state: 'off' })).enabled).toBe('off');
	});

	test('changes keep the rest', () => {
		expect(withEnabled(conn(), false)).toEqual({ enabled: 'off', capabilities: { write: 'off' }, tools: { put: 'ask' } });
		expect(withCapabilityMode(conn(), 'read', 'ask').capabilities).toEqual({ read: 'ask', write: 'off' });
		expect(withCapabilityMode(conn(), 'write', null).capabilities).toBeUndefined();
		expect(withToolMode(conn(), 'put', null).tools).toBeUndefined();
		expect(withToolMode(conn(), 'get', 'off').tools).toEqual({ get: 'off', put: 'ask' });
	});

	test('applyChoices is an optimistic view', () => {
		const next = applyChoices(conn(), { enabled: 'off', capabilities: { read: 'ask' } });
		expect(next.enabled).toBe(false);
		expect(next.capabilities[0]?.mode).toBe('ask');
		expect(next.capabilities[1]?.mode).toBe('ask');
		expect(applyChoices(conn({ state: 'off', enabled: false }), null).enabled).toBe(true);
	});
});
