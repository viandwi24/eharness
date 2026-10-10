import { describe, expect, test } from 'bun:test';
import type { Connection, Connector } from '../api/client';
import { categoriesOf, capabilitiesOf, directorySections, matchesQuery } from './core';
import { alwaysAsks, iconKey, modeOf, OAUTH_CLIENT_NEEDS_SETUP, scopeLabel, splitMemory, statusInfo } from './view';

const cap = (id: string, kind: 'read' | 'write' = 'read') => ({ id, title: id, description: '', kind, tools: [], defaultMode: 'allow' as const });
const conn = (id: string, category: string, builtin = false, extra: Partial<Connector> = {}) =>
	({ id, name: id.toUpperCase(), description: `about ${id}`, category, builtin, capabilities: [cap('a')], ...extra }) as unknown as Connector;
const link = (id: string, definitionId: string, extra: Partial<Connection> = {}) => ({ id, definitionId, scope: 'workspace', status: 'connected', enabled: true, ...extra }) as Connection;

const list = [conn('files', 'workspace', true), conn('github', 'development'), conn('mcp', 'custom'), conn('memory', 'workspace', true)];

describe('directory', () => {
	test('sections: built-ins included, connected vs available', () => {
		const s = directorySections(list, [link('1', 'github')]);
		expect(s.included.map((c) => c.id)).toEqual(['files', 'memory']);
		expect(s.connected.map((c) => c.id)).toEqual(['github']);
		expect(s.available.map((c) => c.id)).toEqual(['mcp']);
	});
	test('filters by query and category', () => {
		expect(directorySections(list, [], { query: 'git' }).available.map((c) => c.id)).toEqual(['github']);
		expect(directorySections(list, [], { category: 'workspace' }).included).toHaveLength(2);
		expect(directorySections(list, [], { category: 'workspace' }).available).toHaveLength(0);
	});
	test('categoriesOf is unique and ordered', () => expect(categoriesOf(list)).toEqual(['workspace', 'development', 'custom']));
	test('matchesQuery covers name, description, category and blank', () => {
		expect(matchesQuery(list[1]!, '')).toBe(true);
		expect(matchesQuery(list[1]!, 'ABOUT')).toBe(true);
		expect(matchesQuery(list[1]!, 'develop')).toBe(true);
		expect(matchesQuery(list[1]!, 'zzz')).toBe(false);
	});
	test('capabilitiesOf prefers the connection capabilities', () => {
		const c = conn('x', 'custom');
		expect(capabilitiesOf(c, undefined).map((k) => k.id)).toEqual(['a']);
		expect(capabilitiesOf(c, link('1', 'x', { capabilities: [cap('b')] })).map((k) => k.id)).toEqual(['b']);
		expect(capabilitiesOf(c, link('1', 'x', { capabilities: [] })).map((k) => k.id)).toEqual(['a']);
	});
});

describe('view helpers', () => {
	test('iconKey falls back to plugs', () => {
		expect(iconKey('brain')).toBe('brain');
		expect(iconKey('nope')).toBe('plugs');
		expect(iconKey(undefined)).toBe('plugs');
	});
	test('statusInfo', () => {
		expect(statusInfo({ status: 'needs-auth', enabled: true }).label).toBe('Reconnect needed');
		expect(statusInfo({ status: 'connected', enabled: false }).label).toBe('Off');
		expect(statusInfo({ status: 'error', enabled: true }).variant).toBe('destructive');
		expect(statusInfo({ status: 'connected', enabled: true }).label).toBe('Connected');
	});
	test('scopeLabel', () => {
		const names = (id: string) => (id === 'a1' ? 'Lead' : undefined);
		expect(scopeLabel({ scope: 'workspace' }, names)).toBe('Whole workspace');
		expect(scopeLabel({ scope: 'agent', scopeId: 'a1' }, names)).toBe('Only Lead');
		expect(scopeLabel({ scope: 'agent', scopeId: 'zz' }, names)).toBe('Only one agent');
	});
	test('modeOf and alwaysAsks', () => {
		expect(modeOf({ defaultModes: { a: 'off' } }, { id: 'a', defaultMode: 'allow' })).toBe('off');
		expect(modeOf({}, { id: 'a', defaultMode: 'ask' })).toBe('ask');
		expect(alwaysAsks({ builtin: false }, { kind: 'write' }, 'ask')).toBe(true);
		expect(alwaysAsks({ builtin: false }, { kind: 'read' }, 'ask')).toBe(false);
		expect(alwaysAsks({ builtin: true }, { kind: 'write' }, 'ask')).toBe(false);
		expect(alwaysAsks({ builtin: false }, { kind: 'write' }, 'allow')).toBe(false);
	});
	test('splitMemory', () => {
		const s = splitMemory([link('1', 'memory'), link('2', 'memory', { scope: 'agent', scopeId: 'a' })]);
		expect(s.workspace).toHaveLength(1);
		expect(s.agents).toHaveLength(1);
	});
	test('oauth setup needed', () => {
		expect(OAUTH_CLIENT_NEEDS_SETUP(conn('g', 'd', false, { oauthClient: { required: true, configured: false } as never }))).toBe(true);
		expect(OAUTH_CLIENT_NEEDS_SETUP(conn('g', 'd'))).toBe(false);
	});
});
