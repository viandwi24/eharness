import { describe, expect, test } from 'bun:test';
import { describeTrigger, fromManifest, scheduleFromSpec, simpleCanShow, specFromSchedule, toManifest } from './manifest-model';

describe('manifest model', () => {
	test('a round trip keeps a manifest and leaves out defaults', () => {
		const m = {
			triggers: [
				{ kind: 'channel', events: ['message.created'], chats: ['Ops'], textContains: ['halo'] },
				{ kind: 'schedule', spec: { kind: 'cron', expr: '30 9 * * 1,3', timezone: 'Asia/Jakarta' } },
				{ kind: 'table', table: 'orders', events: ['row.created'] }
			],
			grants: { send: [{ connection: 'c1', chat: 'VIP' }], reply: true, tablesWrite: ['orders'] },
			cooldownSec: 10
		};
		const back = toManifest(fromManifest(m));
		expect(back).toEqual({ ...m, grants: { send: [{ connection: 'c1', chat: 'VIP' }], reply: true, tablesWrite: ['orders'] } });
		expect(simpleCanShow(m)).toBe(true);
	});

	test('empty values are dropped, the hourly cap default stays implicit', () => {
		const s = fromManifest({});
		expect(s.maxRunsPerHour).toBe(60);
		expect(toManifest(s)).toEqual({ triggers: [], grants: {} });
		s.grants.send.push({ connection: '', chat: 'x', topic: '' });
		s.grants.http.push(' ', 'api.example.com', 'api.example.com');
		expect(toManifest(s).grants).toEqual({ http: ['api.example.com'] });
	});

	test('schedules in friendly terms', () => {
		expect(scheduleFromSpec({ kind: 'cron', expr: '0 9 * * *' })).toEqual({ mode: 'daily', time: '09:00', timezone: '' });
		expect(scheduleFromSpec({ kind: 'cron', expr: '5 18 * * 1,5', tz: 'UTC' })).toEqual({ mode: 'weekly', days: [1, 5], time: '18:05', timezone: 'UTC' });
		expect(scheduleFromSpec({ kind: 'cron', expr: '*/5 * * * *' })).toEqual({ mode: 'cron', expr: '*/5 * * * *', timezone: '' });
		expect(scheduleFromSpec({ kind: 'every', everyMs: 7_200_000 })).toEqual({ mode: 'every', every: 2, unit: 'hours' });
		expect(specFromSchedule({ mode: 'every', every: 15, unit: 'minutes' })).toEqual({ kind: 'every', everyMs: 900_000 });
		expect(specFromSchedule({ mode: 'weekly', days: [5, 1, 1], time: '07:30', timezone: '' })).toEqual({ kind: 'cron', expr: '30 7 * * 1,5' });
	});

	test('fields the simple editor cannot show switch it off', () => {
		expect(simpleCanShow({ triggers: [], extra: 1 })).toBe(false);
	});

	test('a line per trigger', () => {
		const [t] = fromManifest({ triggers: [{ kind: 'channel', events: ['message.created'], chats: ['Ops'], textContains: ['halo'] }] }).triggers;
		expect(describeTrigger(t!)).toBe('New message in Ops containing “halo”');
		expect(describeTrigger({ kind: 'schedule', schedule: { mode: 'daily', time: '09:00', timezone: '' } })).toBe('Every day at 09:00');
	});

	test('app and webhook triggers and API grants survive a round trip', () => {
		const m = {
			triggers: [{ kind: 'app', events: ['task-changed'], agents: ['lead'], match: { change: 'done' } }, { kind: 'webhook' }],
			grants: { api: ['GET /tasks/**'] }
		};
		expect(toManifest(fromManifest(m))).toEqual(m);
		const [app, hook] = fromManifest(m).triggers;
		expect(describeTrigger(app!)).toBe('Task changed of lead where change = done');
		expect(describeTrigger(hook!)).toContain('POST');
	});

	test('read, moderate, native action and notify grants survive a round trip (simple mode can show them)', () => {
		const m = {
			triggers: [],
			grants: {
				read: [{ connection: 'c1', chat: 'Signals' }],
				moderate: [{ connection: 'c1', chat: '*' }],
				actions: [{ connection: 'c1', name: 'create_link' }],
				notify: true
			}
		};
		expect(toManifest(fromManifest(m))).toEqual(m);
		expect(simpleCanShow(m)).toBe(true);
	});

	test('table triggers keep fields, a filter and starts-to-match; a broken filter stays out', () => {
		const m = { triggers: [{ kind: 'table', table: 'sig', events: ['row.updated'], fields: ['status'], where: { status: 'closed' }, startsToMatch: true }], grants: {} };
		expect(toManifest(fromManifest(m))).toEqual(m);
		const [t] = fromManifest(m).triggers;
		expect(describeTrigger(t!)).toBe('row changed in table sig when status changes becoming {"status":"closed"}');
		const broken = fromManifest(m);
		(broken.triggers[0] as { where: string }).where = '{ status: ';
		expect(toManifest(broken).triggers).toEqual([{ kind: 'table', table: 'sig', events: ['row.updated'], fields: ['status'] }]);
	});

	test('message filters survive a round trip and read as a line', () => {
		const m = {
			triggers: [{ kind: 'channel', events: ['message.created'], messageKinds: ['photo', 'album'], forwardFrom: ['Signals HQ'], isReply: false, isForward: true, hasLink: true }],
			grants: {}
		};
		expect(toManifest(fromManifest(m))).toEqual(m);
		const [t] = fromManifest(m).triggers;
		expect(describeTrigger(t!)).toBe('New message (Photo or Album) no replies forwarded from Signals HQ with a link');
		// left open: nothing written
		const open = fromManifest({ triggers: [{ kind: 'channel', events: ['message.created'] }] });
		expect(toManifest(open).triggers).toEqual([{ kind: 'channel', events: ['message.created'] }]);
	});
});
