import { describe, expect, test } from 'bun:test';
import type { BeatRecord, HeartbeatConfig, StandingOrder } from './model';
import { BEAT_LABEL, beatDetail, beatTone, decisionLine, filesLink, formErrors, formOf, groupOrders, NO_ORDERS, orderTiming, orderWhere, orderWho, patchOf, refLink, scheduleSummary } from './model';

const config: HeartbeatConfig = {
	enabled: true,
	everyMinutes: 30,
	activeFrom: '08:00',
	activeTo: '20:00',
	timezone: 'UTC'
};
const beat = (over: Partial<BeatRecord>): BeatRecord => ({
	id: '1',
	at: 0,
	endedAt: 0,
	status: 'ok',
	reason: null,
	count: 1,
	items: [],
	duplicates: 0,
	...over
});

describe('heartbeat form', () => {
	test('a valid form has no errors; every field is checked', () => {
		expect(formErrors(formOf(config))).toEqual({});
		expect(Object.keys(formErrors({ ...formOf(config), everyMinutes: 2, activeFrom: '8', activeTo: '24:00', timezone: 'Mars/Base' })).sort()).toEqual([
			'activeFrom',
			'activeTo',
			'everyMinutes',
			'timezone'
		]);
		expect(formErrors({ ...formOf(config), everyMinutes: 12.5 }).everyMinutes).toBeTruthy();
		expect(formErrors({ ...formOf(config), everyMinutes: 1441 }).everyMinutes).toBeTruthy();
	});

	test('the patch holds only what changed', () => {
		expect(patchOf(config, formOf(config))).toEqual({});
		expect(patchOf(config, { ...formOf(config), everyMinutes: 60 })).toEqual({ everyMinutes: 60 });
	});

	test('an empty timezone follows the team timezone', () => {
		const team = { ...config, timezone: null };
		expect(formOf(team).timezone).toBe('');
		expect(formErrors(formOf(team))).toEqual({});
		expect(patchOf(team, formOf(team))).toEqual({});
		expect(patchOf(config, { ...formOf(config), timezone: '' })).toEqual({ timezone: null });
		expect(patchOf(team, { ...formOf(team), timezone: 'Asia/Jakarta' })).toEqual({ timezone: 'Asia/Jakarta' });
		expect(scheduleSummary(team, 'Asia/Jakarta')).toBe('every 30 min, 08:00-20:00 Asia/Jakarta');
	});

	test('the schedule reads like a sentence', () => {
		expect(scheduleSummary(config)).toBe('every 30 min, 08:00-20:00 UTC');
		expect(scheduleSummary({ ...config, everyMinutes: 120, activeTo: '08:00' })).toBe('every 2 h, around the clock');
	});
});

describe('standing orders', () => {
	const order = (over: Partial<StandingOrder> = {}): StandingOrder => ({
		id: 'o1',
		text: 'Watch the community channel',
		by: 'ident-1',
		name: 'Ana',
		role: 'admin',
		report: { kind: 'chat', connectionId: 'c1', nodeId: 'n1' },
		reportLabel: 'Internal',
		mention: true,
		at: 0,
		active: true,
		kind: 'watch',
		state: 'active',
		refs: [],
		needs: [],
		...over
	});

	test('who asked and where it reports read as short phrases', () => {
		expect(orderWho(order())).toBe('Ana (admin)');
		expect(orderWho(order({ by: 'web:owner', name: 'the owner', role: 'owner' }))).toBe('You (owner)');
		expect(orderWho(order({ name: ' ' }))).toBe('Someone (admin)');
		expect(orderWhere(order())).toBe('Reports to Internal, tagging them');
		expect(orderWhere(order({ mention: false }))).toBe('Reports to Internal');
		expect(orderWhere(order({ report: { kind: 'web', sessionId: 's' }, mention: false }))).toBe('Reports in the web chat');
		expect(NO_ORDERS).toContain('Tell the agent in chat');
	});

	test('the form has only the advanced fields; decisions read as an audit line; the notes link points at the file', () => {
		expect(Object.keys(formOf(config)).sort()).toEqual(['activeFrom', 'activeTo', 'everyMinutes', 'timezone']);
		expect(decisionLine({ decision: 'report', reason: 'due at 15:00' })).toBe('Reported: due at 15:00');
		expect(decisionLine({ decision: 'say', reason: 'old word' })).toBe('Reported: old word');
		expect(decisionLine({ decision: 'note' })).toBe('Noted');
		expect(decisionLine({ decision: 'retry', reason: 'connection is back' })).toBe('Retried: connection is back');
		expect(decisionLine({})).toBe('');
		expect(filesLink('/library/notes/heartbeat/a/2026-10-15.md')).toBe('/files?path=%2Flibrary%2Fnotes%2Fheartbeat%2Fa%2F2026-10-15.md');
	});

	test('a beat started by chat activity says so', () => {
		expect(beatDetail(beat({ status: 'ok', trigger: 'activity' }))).toContain('chat activity');
	});
});

describe('orders by kind', () => {
	const o = (over: Partial<StandingOrder>): StandingOrder => ({
		id: 'x',
		text: 't',
		by: 'b',
		name: 'n',
		role: 'owner',
		report: { kind: 'web', sessionId: 's' },
		reportLabel: 'the web chat',
		mention: false,
		at: 1,
		active: true,
		kind: 'watch',
		state: 'active',
		refs: [],
		needs: [],
		...over
	});

	test('grouped by kind, deadlines by due time; done and expired ones apart', () => {
		const { groups, closed } = groupOrders([
			o({ id: 'w' }),
			o({ id: 'd2', kind: 'deadline', due: 20 }),
			o({ id: 'd1', kind: 'deadline', due: 10 }),
			o({ id: 'r', kind: 'rule' }),
			o({ id: 'done', kind: 'deadline', state: 'done', done: { at: 5, outcome: 'ok' } }),
			o({ id: 'exp', state: 'expired', expires: 3 })
		]);
		expect(groups.map((g) => g.kind)).toEqual(['deadline', 'rule', 'watch']);
		expect(groups[0]?.orders.map((x) => x.id)).toEqual(['d1', 'd2']);
		expect(closed.map((x) => x.id)).toEqual(['done', 'exp']);
		expect(orderTiming(o({ due: 1, expires: 2 }), (ms) => `t${ms}`)).toEqual(['Due t1', 'Expires t2']);
		expect(orderTiming(o({ state: 'expired', expires: 2 }), (ms) => `t${ms}`)).toEqual(['Expired t2']);
	});

	test('references link to what the app can open', () => {
		expect(refLink('https://youtube.com/@x')).toEqual({ text: 'https://youtube.com/@x', href: 'https://youtube.com/@x' });
		expect(refLink('/library/a.md').href).toBe('/files?path=%2Flibrary%2Fa.md');
		expect(refLink('General #12345')).toEqual({ text: 'General #12345' });
	});
});

describe('beat history', () => {
	test('each status has a label and a tone; the detail says what happened', () => {
		for (const s of ['running', 'ok', 'attention', 'skipped', 'failed'] as const) {
			expect(BEAT_LABEL[s]).toBeTruthy();
			expect(beatTone(s)).toBeTruthy();
		}
		expect(beatDetail(beat({ status: 'skipped', reason: 'empty checklist', count: 3 }))).toBe('empty checklist (3 times)');
		expect(beatDetail(beat({ status: 'skipped', reason: 'outside active hours' }))).toBe('outside active hours');
		expect(beatDetail(beat({ status: 'failed', reason: 'stopped: error' }))).toBe('stopped: error');
		expect(beatDetail(beat({ status: 'ok' }))).toBe('Nothing needed attention');
		expect(beatDetail(beat({ status: 'ok', duplicates: 2 }))).toBe('2 findings already reported');
		const item = { kind: 'x', title: 't', detail: '', links: [], urgent: false, fingerprint: 'f' };
		expect(beatDetail(beat({ status: 'attention', items: [item], duplicates: 1 }))).toBe('1 new item, 1 already reported');
	});
});
