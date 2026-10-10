import { describe, expect, test } from 'bun:test';
import type { Capability, Connection, CustomProbe } from '../api/client';
import {
	authLabel,
	badHeaderNames,
	canAdd,
	createBody,
	customConnections,
	customState,
	defaultSignIn,
	detectionText,
	headersOf,
	hostOf,
	initialsOf,
	isAllowedUrl,
	matchesCustom,
	needsOwnClient,
	toolCount,
	toolGroups,
	validateDetails,
	type ReviewForm
} from './custom';
import { categoriesOf, directorySections } from './core';

const conn = (id: string, extra: Partial<Connection> = {}) => ({ id, definitionId: 'mcp-remote', label: id, custom: true, scope: 'workspace', status: 'connected', enabled: true, settings: {}, createdAt: 1, ...extra }) as Connection;
const probe = (extra: Partial<CustomProbe>) => ({ detected: 'none', message: 'm', ...extra }) as CustomProbe;
const form = (extra: Partial<ReviewForm> = {}): ReviewForm => ({ name: ' Docs ', url: ' https://x.test/mcp ', signIn: 'later', clientId: '', clientSecret: '', headers: [], availableToAll: false, ...extra });

describe('step 1', () => {
	test('https or localhost only', () => {
		expect(isAllowedUrl('https://mcp.example.com/mcp')).toBe(true);
		expect(isAllowedUrl('http://localhost:3000/mcp')).toBe(true);
		expect(isAllowedUrl('http://example.com/mcp')).toBe(false);
		expect(isAllowedUrl('nope')).toBe(false);
	});
	test('validateDetails', () => {
		expect(validateDetails('Docs', 'https://x.test/mcp')).toEqual({});
		expect(validateDetails(' ', '')).toEqual({ name: 'Give it a name.', url: 'Enter the server URL.' });
		expect(validateDetails('x'.repeat(61), 'ftp://x').name).toContain('60');
		expect(validateDetails('x', 'ftp://x').url).toContain('https');
	});
});

describe('review', () => {
	test('detection preselects the sign-in choice', () => {
		expect(defaultSignIn(probe({ detected: 'oauth' }))).toBe('now');
		expect(defaultSignIn(probe({ detected: 'none' }))).toBe('none');
		expect(defaultSignIn(probe({ detected: 'unknown' }))).toBe('none');
		expect(defaultSignIn(null)).toBe('none');
	});
	test('detection text and own client hint', () => {
		expect(detectionText(null)).toBe('');
		expect(detectionText(probe({ detected: 'none', tools: 1 }))).toBe('No sign in needed. 1 tool found.');
		expect(detectionText(probe({ detected: 'oauth', oauth: { discovered: true, dynamicRegistration: true } }))).toContain('OAuth');
		expect(detectionText(probe({ detected: 'unknown', message: 'Could not reach the server.' }))).toContain('still add');
		expect(needsOwnClient(probe({ detected: 'oauth', oauth: { discovered: true, dynamicRegistration: false } }))).toBe(true);
		expect(needsOwnClient(probe({ detected: 'oauth', oauth: { discovered: true, dynamicRegistration: true } }))).toBe(false);
		expect(needsOwnClient(probe({ detected: 'none' }))).toBe(false);
	});
	test('headers: blank rows dropped, bad names found', () => {
		expect(headersOf([{ key: '', value: 'x' }])).toBeUndefined();
		expect(headersOf([{ key: ' X-Key ', value: 'v' }, { key: '', value: '' }])).toEqual({ 'X-Key': 'v' });
		expect(badHeaderNames([{ key: 'bad name', value: '' }, { key: 'Ok-1', value: '' }, { key: '', value: '' }])).toEqual(['bad name']);
	});
	test('createBody trims, sends the OAuth client only when signing in, scopes to an agent', () => {
		expect(createBody(form({ clientId: 'id', clientSecret: ' s ' }))).toEqual({ name: 'Docs', url: 'https://x.test/mcp', signIn: 'later', oauthClient: { clientId: 'id', clientSecret: 's' }, availableToAll: false });
		expect(createBody(form({ signIn: 'none', clientId: 'id', headers: [{ key: 'A', value: 'b' }], availableToAll: true }))).toEqual({ name: 'Docs', url: 'https://x.test/mcp', signIn: 'none', headers: { A: 'b' }, availableToAll: true });
		expect(createBody(form(), 'a1')).toMatchObject({ scope: 'agent', scopeId: 'a1' });
		expect(createBody(form(), 'a1')).not.toHaveProperty('availableToAll');
	});
	test('canAdd', () => {
		expect(canAdd(form())).toBe(true);
		expect(canAdd(form({ name: '' }))).toBe(false);
		expect(canAdd(form({ headers: [{ key: 'bad name', value: '' }] }))).toBe(false);
	});
});

describe('directory cards', () => {
	test('each custom connection is its own card, oldest first; the generic connector is not a card', () => {
		const all = [conn('b', { createdAt: 2 }), conn('a', { createdAt: 1 }), { ...conn('gh'), custom: false, definitionId: 'github' } as Connection];
		expect(customConnections(all).map((c) => c.id)).toEqual(['a', 'b']);
		const generic = { id: 'mcp-remote', name: 'Custom connector', description: '', category: 'custom', source: 'custom', builtin: false, capabilities: [] } as never;
		const s = directorySections([generic], [conn('a')]);
		expect([...s.connected, ...s.available, ...s.included]).toEqual([]);
		expect(categoriesOf([generic])).toEqual([]);
	});
	test('state, labels, host, initials, search', () => {
		expect(customState({ status: 'needs-auth', enabled: true })).toBe('needs-sign-in');
		expect(customState({ status: 'error', enabled: true })).toBe('error');
		expect(customState({ status: 'connected', enabled: false })).toBe('off');
		expect(customState({ status: 'connected', enabled: true })).toBe('connected');
		expect(authLabel({ settings: { authMode: 'oauth' } })).toBe('OAuth sign in');
		expect(authLabel({ settings: { authMode: 'headers' } })).toBe('Request headers');
		expect(authLabel({ settings: {} })).toBe('No sign in');
		expect(hostOf({ settings: { url: 'https://mcp.example.com/mcp' } })).toBe('mcp.example.com');
		expect(hostOf({ settings: {} })).toBe('');
		expect(initialsOf('Company docs')).toBe('CD');
		expect(initialsOf('github')).toBe('GI');
		expect(initialsOf('  ')).toBe('?');
		const c = conn('x', { label: 'Company docs', settings: { url: 'https://mcp.acme.io/mcp' } });
		expect(matchesCustom(c, 'DOCS')).toBe(true);
		expect(matchesCustom(c, 'acme')).toBe(true);
		expect(matchesCustom(c, 'zzz')).toBe(false);
		expect(matchesCustom(c, '')).toBe(true);
	});
	test('tool groups: reads first, everything else as changes', () => {
		const cap = (id: string, kind: Capability['kind'], tools: string[]) => ({ id, title: id, description: '', kind, tools, defaultMode: 'allow' }) as Capability;
		const caps = [cap('r', 'read', ['a', 'b']), cap('w', 'write', ['c']), cap('d', 'destructive', ['d'])];
		expect(toolGroups(caps).reads.map((c) => c.id)).toEqual(['r']);
		expect(toolGroups(caps).writes.map((c) => c.id)).toEqual(['w', 'd']);
		expect(toolCount(caps)).toBe(4);
	});
});
