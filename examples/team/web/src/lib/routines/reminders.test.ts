import { describe, expect, test } from 'bun:test';
import { remindersFor, reminderBadge, reminderStatus, type ReminderRow } from './reminders';

const r = (over: Partial<ReminderRow>): ReminderRow => ({
	id: 'r1',
	connectionId: 'c1',
	agentId: 'a1',
	nodeId: 'n1',
	chatTitle: 'produksi',
	place: 'TEAMKU/produksi',
	text: 'Waktunya pulang',
	whenText: 'once, Mon 2026-10-12 17:05 Asia/Jakarta',
	status: 'active',
	mentions: [],
	createdAt: 1,
	fireCount: 0,
	...over
});

describe('reminders page', () => {
	test('badge names the chat and topic; status tells done from cancelled', () => {
		expect(reminderBadge(r({}))).toBe('Reminder · TEAMKU/produksi');
		expect(reminderStatus(r({ status: 'active' })).label).toBe('active');
		expect(reminderStatus(r({ status: 'done' })).label).toBe('done');
		expect(reminderStatus(r({ status: 'cancelled' })).label).toBe('cancelled');
	});
	test('the filter keeps finished reminders visible and respects the agent filter', () => {
		const rows = [r({ id: 'a' }), r({ id: 'b', status: 'done' }), r({ id: 'c', status: 'cancelled', agentId: 'a2' })];
		expect(remindersFor('all', rows).map((x) => x.id)).toEqual(['a', 'b', 'c']);
		expect(remindersFor('active', rows).map((x) => x.id)).toEqual(['a']);
		expect(remindersFor('finished', rows).map((x) => x.id)).toEqual(['b', 'c']);
		expect(remindersFor('all', rows, 'a1').map((x) => x.id)).toEqual(['a', 'b']);
	});
});
