import { describe, expect, test } from 'bun:test';
import { buildSpec, defaultScheduleForm, describeSpec, parseSpec, relativeTime, routineBadge, validCronShape } from './schedule';

const form = (o: Partial<ReturnType<typeof defaultScheduleForm>>) => ({ ...defaultScheduleForm('Europe/Berlin'), ...o });

describe('schedule presets', () => {
	test('daily, weekdays and weekly become cron with the timezone', () => {
		expect(buildSpec(form({ kind: 'daily', time: '09:00' }))).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin' });
		expect(buildSpec(form({ kind: 'weekdays', time: '8:30' }))).toEqual({ kind: 'cron', expr: '30 8 * * 1-5', tz: 'Europe/Berlin' });
		expect(buildSpec(form({ kind: 'weekly', time: '17:05', weekday: 5 }))).toEqual({ kind: 'cron', expr: '5 17 * * 5', tz: 'Europe/Berlin' });
	});

	test('every N minutes uses the interval spec', () => {
		expect(buildSpec(form({ kind: 'every', everyMinutes: 15 }))).toEqual({ kind: 'every', everyMs: 900_000 });
		expect(() => buildSpec(form({ kind: 'every', everyMinutes: 0 }))).toThrow();
	});

	test('custom cron is validated by shape and normalised', () => {
		expect(buildSpec(form({ kind: 'custom', expr: ' 0  9 * *  1-5 ' }))).toEqual({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'Europe/Berlin' });
		expect(validCronShape('0 9 * *')).toBe(false);
		expect(validCronShape('*/5 * * * * *')).toBe(true);
		expect(() => buildSpec(form({ kind: 'custom', expr: 'nope' }))).toThrow();
		expect(() => buildSpec(form({ kind: 'daily', time: '25:00' }))).toThrow();
	});

	test('parseSpec is the inverse of buildSpec for presets, custom otherwise', () => {
		for (const f of [form({ kind: 'daily', time: '09:00' }), form({ kind: 'weekdays', time: '08:00' }), form({ kind: 'weekly', time: '10:15', weekday: 2 }), form({ kind: 'every', everyMinutes: 45 })]) {
			const back = parseSpec(buildSpec(f), 'UTC');
			expect(back.kind).toBe(f.kind);
			expect(buildSpec(back)).toEqual(buildSpec(f));
		}
		expect(parseSpec({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' }).kind).toBe('custom');
		expect(parseSpec({ kind: 'at', at: 1000 }).kind).toBe('once');
	});

	test('describeSpec', () => {
		expect(describeSpec({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe('Every day at 09:00');
		expect(describeSpec({ kind: 'cron', expr: '0 8 * * 1-5', tz: 'UTC' })).toBe('Weekdays at 08:00');
		expect(describeSpec({ kind: 'cron', expr: '0 9 * * 1', tz: 'UTC' })).toBe('Mondays at 09:00');
		expect(describeSpec({ kind: 'every', everyMs: 1_800_000 })).toBe('Every 30 minutes');
		expect(describeSpec({ kind: 'every', everyMs: 3_600_000 })).toBe('Every hour');
		expect(describeSpec({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' })).toBe('Cron */5 * * * *');
	});

	test('badge and relative time', () => {
		expect(routineBadge({ status: 'active', pausedReason: null, failures: 0 }).variant).toBe('success');
		expect(routineBadge({ status: 'paused', pausedReason: 'max-failures', failures: 3 }).variant).toBe('destructive');
		expect(routineBadge({ status: 'paused', pausedReason: 'manual', failures: 0 }).label).toBe('paused');
		expect(relativeTime(1_000_000 + 5 * 60_000, 1_000_000)).toBe('in 5 min');
		expect(relativeTime(1_000_000 - 2 * 3_600_000, 1_000_000)).toBe('2 h ago');
		expect(relativeTime(null)).toBe('—');
	});
});
