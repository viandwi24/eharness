import { describe, expect, test } from 'bun:test';
import type { BeatRecord, HeartbeatConfig, StandingOrder } from './model';
import { BEAT_LABEL, beatDetail, beatTone, decisionLine, filesLink, formErrors, formOf, NO_ORDERS, orderWhere, orderWho, patchOf, scheduleSummary } from './model';

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
		expect(decisionLine({})).toBe('');
		expect(filesLink('/library/notes/heartbeat/a/2026-10-15.md')).toBe('/files?path=%2Flibrary%2Fnotes%2Fheartbeat%2Fa%2F2026-10-15.md');
	});

	test('a beat started by chat activity says so', () => {
		expect(beatDetail(beat({ status: 'ok', trigger: 'activity' }))).toContain('chat activity');
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
