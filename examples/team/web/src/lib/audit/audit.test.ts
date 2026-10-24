import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_LABEL, actionLabel, subActionOf } from '../channels/model';
import { setTeamZone } from '../time';
import {
	activeFilterCount,
	connectorText,
	emptyFilters,
	filtersFromParams,
	paramsFromFilters,
	queryOf,
	requesterText,
	resultLabel,
	resultVariant,
	roleText,
	summaryPairs,
	targetText,
	windowOf
} from './audit';

describe('audit filters', () => {
	test('the defaults leave the URL clean and round-trip', () => {
		expect(paramsFromFilters(emptyFilters()).toString()).toBe('');
		const f = { ...emptyFilters(), range: '30d' as const, kind: 'all' as const, connectionId: 'c1', transport: 'user' as const, action: 'ban_member', chat: 'Ops', requester: 'web owner', agentId: 'a1', result: 'refused' as const };
		const back = filtersFromParams(new URLSearchParams(paramsFromFilters(f).toString()));
		expect(back).toEqual(f);
	});
	test('unknown values are ignored; dates make a custom range', () => {
		const f = filtersFromParams(new URLSearchParams('range=bogus&kind=x&result=nope&transport=sms&from=2026-10-01&to=bad'));
		expect(f).toMatchObject({ kind: 'action', result: '', transport: '', from: '2026-10-01', to: '', range: 'custom' });
	});
	test('the query carries the same filters the CSV takes; kind=all sends none', () => {
		setTeamZone('UTC');
		const now = Date.UTC(2026, 9, 24, 15, 30);
		expect(queryOf(emptyFilters(), now)).toEqual({ from: now - 7 * 86_400_000, kind: 'action' });
		const q = queryOf({ ...emptyFilters(), range: 'today', kind: 'all', transport: 'bot', chat: ' Ops ', result: 'error' }, now);
		expect(q).toEqual({ from: Date.UTC(2026, 9, 24), transport: 'bot', platform: 'telegram', chat: 'Ops', result: 'error' });
	});
	test('windows: quick ranges, custom days in the team timezone, all time is open', () => {
		setTeamZone('Asia/Jakarta');
		const now = Date.UTC(2026, 9, 24, 20, 0); // 03:00 on the 25th in Jakarta
		expect(windowOf({ ...emptyFilters(), range: 'today' }, now)).toEqual({ from: Date.UTC(2026, 9, 24, 17) });
		expect(windowOf({ ...emptyFilters(), range: 'all' }, now)).toEqual({});
		const w = windowOf({ ...emptyFilters(), range: 'custom', from: '2026-10-24', to: '2026-10-24' }, now);
		expect(w).toEqual({ from: Date.UTC(2026, 9, 23, 17), to: Date.UTC(2026, 9, 24, 17) - 1 });
		setTeamZone('UTC');
	});
	test('active filters count what the badge shows', () => {
		expect(activeFilterCount(emptyFilters())).toBe(0);
		expect(activeFilterCount({ ...emptyFilters(), kind: 'read', result: 'ok', chat: 'x' })).toBe(3);
	});
});

describe('audit words', () => {
	test('requester, role, target and connector', () => {
		expect(requesterText({ requester: 'Vian' })).toBe('Vian');
		expect(requesterText({ origin: 'routine' })).toBe('autonomous routine');
		expect(requesterText({ origin: 'chat' })).toBe('the agent');
		expect(roleText({ requester: 'web owner', role: 'owner' })).toBeUndefined();
		expect(roleText({ requester: 'Eve', role: 'member' })).toBe('member');
		expect(targetText({ target: { chat: 'Ops', user: '@ana', link: 't.me/x' } })).toBe('Ops · user @ana · t.me/x');
		expect(targetText({ target: {} })).toBe('');
		expect(connectorText({ platform: 'telegram', transport: 'user' })).toBe('Telegram account');
		expect(connectorText({ platform: 'telegram', transport: 'bot' })).toBe('Telegram bot');
		expect(connectorText({ platform: 'unknown' })).toBe('Platform');
	});
	test('results', () => {
		expect(resultLabel('rate_limited')).toBe('Rate limited');
		expect(resultVariant('ok')).toBe('success');
		expect(resultVariant('error')).toBe('destructive');
		expect(resultVariant('refused')).toBe('secondary');
	});
	test('a summary becomes key and value pairs; text stays a length', () => {
		expect(summaryPairs('chat=-100123 user=@ana text=<13 chars> rights=[2]a,b')).toEqual([
			{ key: 'chat', value: '-100123' },
			{ key: 'user', value: '@ana' },
			{ key: 'text', value: '<13 chars>' },
			{ key: 'rights', value: '[2]a,b' }
		]);
		expect(summaryPairs(undefined)).toEqual([]);
	});
});

describe('action labels', () => {
	test('a tool, a sub-action and an unknown name', () => {
		expect(actionLabel('ban_member')).toBe('Ban member');
		expect(subActionOf('chat=1 action=ban user=2')).toBe('ban');
		expect(actionLabel('chat_members', 'chat=1 action=ban user=2')).toBe('Ban member');
		expect(actionLabel('chat_members', 'action=teleport')).toBe('Members · teleport');
		expect(actionLabel('brand_new_tool')).toBe('Brand new tool');
	});

	// every tool the Telegram connectors define has a label (the Audit and Activity pages never show a raw name)
	const server = join(import.meta.dir, '../../../../server/src/infra');
	const names = (file: string): string[] => [...readFileSync(join(server, file), 'utf8').matchAll(/^\s+name: '([a-z_]+)',\n\s+risk: '/gm)].map((m) => m[1] as string);
	for (const file of ['telegram-user/actions.ts', 'telegram-user/manage.ts', 'telegram/actions.ts']) {
		test(`every tool of ${file} is labelled`, () => {
			const all = names(file);
			expect(all.length).toBeGreaterThan(5);
			expect(all.filter((n) => ACTION_LABEL[n] === undefined)).toEqual([]);
		});
	}
});
