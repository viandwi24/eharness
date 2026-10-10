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

describe('agent tab rows', () => {
	test('subtitle, sharing text and reset keep the on/off choice', async () => {
		const { isCustomized, resetChoices, rowSubtitle, sharingText } = await import('./agent-view');
		expect(sharingText(conn())).toBe('All agents');
		expect(sharingText(conn({ defaultEnabled: false }))).toBe('Selected agents');
		expect(sharingText(conn({ ownership: 'agent' }))).toBe('Only this agent');
		expect(rowSubtitle(conn({ source: 'builtin' }))).toBe('Built in');
		expect(rowSubtitle(conn({ accountLabel: 'me' }))).toBe('Work · me · All agents');
		expect(rowSubtitle(conn({ status: 'needs-auth' }))).toBe('Reconnect to use it');
		expect(isCustomized(conn())).toBe(true);
		expect(resetChoices(conn({ state: 'on' }))).toEqual({ enabled: 'on' });
		expect(resetChoices(conn())).toBeNull();
	});
});
