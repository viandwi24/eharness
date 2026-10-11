import { describe, expect, test } from 'bun:test';
import type { BeatRecord, HeartbeatConfig } from './model';
import { BEAT_LABEL, beatDetail, beatTone, formErrors, formOf, patchOf, scheduleSummary } from './model';

const config: HeartbeatConfig = { enabled: true, everyMinutes: 30, activeFrom: '08:00', activeTo: '20:00', timezone: 'UTC' };
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
		expect(patchOf(config, { ...formOf(config), enabled: false, everyMinutes: 60 })).toEqual({ enabled: false, everyMinutes: 60 });
	});

	test('the schedule reads like a sentence', () => {
		expect(scheduleSummary(config)).toBe('every 30 min, 08:00-20:00 UTC');
		expect(scheduleSummary({ ...config, everyMinutes: 120, activeTo: '08:00' })).toBe('every 2 h, around the clock');
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
