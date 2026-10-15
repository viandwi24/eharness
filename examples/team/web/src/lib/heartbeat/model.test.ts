import { describe, expect, test } from 'bun:test';
import type { BeatRecord, HeartbeatConfig } from './model';
import { BEAT_LABEL, beatDetail, beatTone, checklistNotice, decisionLine, destinationWarning, filesLink, formErrors, formOf, patchOf, scheduleSummary } from './model';

const config: HeartbeatConfig = {
	enabled: true,
	everyMinutes: 30,
	activeFrom: '08:00',
	activeTo: '20:00',
	timezone: 'UTC',
	mode: 'notes',
	reportTo: null,
	maxPostsPerDay: 6,
	wakeOnActivity: false,
	minGapMinutes: 10
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
		expect(patchOf(config, { ...formOf(config), enabled: false, everyMinutes: 60 })).toEqual({ enabled: false, everyMinutes: 60 });
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

describe('proactive settings', () => {
	const dest = { connectionId: 'c1', nodeId: 'n1', label: 'Internal', platform: 'telegram', kind: 'room', proactive: true };
	test('the report chat is chosen from the list and sent with its connection', () => {
		const f = formOf(config);
		expect(patchOf(config, { ...f, reportTo: 'n1' }, [dest])).toEqual({ reportTo: { connectionId: 'c1', nodeId: 'n1' } });
		const set = { ...config, reportTo: { connectionId: 'c1', nodeId: 'n1' } };
		expect(formOf(set).reportTo).toBe('n1');
		expect(patchOf(set, formOf(set), [dest])).toEqual({});
		expect(patchOf(set, { ...formOf(set), reportTo: '' }, [dest])).toEqual({ reportTo: null });
		expect(patchOf(config, { ...f, wakeOnActivity: true, maxPostsPerDay: 3, minGapMinutes: 15 })).toEqual({ wakeOnActivity: true, maxPostsPerDay: 3, minGapMinutes: 15 });
	});

	test('the caps are checked', () => {
		expect(Object.keys(formErrors({ ...formOf(config), maxPostsPerDay: 51, minGapMinutes: 0 })).sort()).toEqual(['maxPostsPerDay', 'minGapMinutes']);
		expect(formErrors({ ...formOf(config), maxPostsPerDay: 0 })).toEqual({});
	});

	test('an empty checklist says plainly that the heartbeat does nothing', () => {
		expect(checklistNotice({ exists: true, empty: false }, true)).toBeNull();
		expect(checklistNotice({ exists: false, empty: true }, true)).toMatchObject({ tone: 'warning' });
		expect(checklistNotice({ exists: true, empty: true }, true)?.text).toContain('does nothing');
		expect(checklistNotice({ exists: true, empty: true }, false)).toMatchObject({ tone: 'muted' });
	});

	test('a chat that does not allow proactive posts is flagged', () => {
		expect(destinationWarning(dest)).toBeNull();
		expect(destinationWarning({ ...dest, proactive: false })).toContain('proactive');
		expect(destinationWarning(undefined)).toBeNull();
	});

	test('the mode is part of the patch; decisions read as an audit line; the notes link points at the file', () => {
		expect(patchOf(config, { ...formOf(config), mode: 'speak' })).toEqual({ mode: 'speak' });
		expect(decisionLine({ decision: 'say', reason: 'due at 15:00' })).toBe('Said it: due at 15:00');
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
