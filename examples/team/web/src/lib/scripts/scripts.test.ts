import { describe, expect, test } from 'bun:test';
import {
	approvalLabel,
	callLabel,
	canActivate,
	checkManifest,
	formatDuration,
	outcomeTone,
	SCRIPT_NAME,
	type Script,
	shortJson,
	statusLabel,
	TEMPLATE_MANIFEST,
	triggerSummary,
	versionMarkers
} from './scripts';

const approval = (state: Script['approval']['state'], version: number | null = null): Script['approval'] => ({ state, version, by: null, at: null, note: null });

describe('status', () => {
	test('draft, active vN and off with its reason', () => {
		expect(statusLabel({ status: 'draft', activeVersion: null, disabledReason: null })).toEqual({ label: 'draft', tone: 'secondary' });
		expect(statusLabel({ status: 'active', activeVersion: 3, disabledReason: null })).toEqual({ label: 'active v3', tone: 'success' });
		expect(statusLabel({ status: 'disabled', activeVersion: 3, disabledReason: 'manual' }).label).toBe('off');
		const failing = statusLabel({ status: 'disabled', activeVersion: 3, disabledReason: '5 failures in a row' });
		expect(failing.label).toBe('off: 5 failures in a row');
		expect(failing.tone).toBe('warning');
	});
	test('approval badge only when pending or rejected', () => {
		expect(approvalLabel({ approval: approval('none') })).toBeNull();
		expect(approvalLabel({ approval: approval('approved', 2) })).toBeNull();
		expect(approvalLabel({ approval: approval('pending', 4) })?.label).toBe('v4 waits for approval');
		expect(approvalLabel({ approval: approval('rejected', 4) })?.label).toBe('v4 rejected');
	});
	test('activate when not running the latest version', () => {
		expect(canActivate({ status: 'draft', activeVersion: null, latestVersion: 1 })).toBe(true);
		expect(canActivate({ status: 'active', activeVersion: 2, latestVersion: 2 })).toBe(false);
		expect(canActivate({ status: 'active', activeVersion: 2, latestVersion: 3 })).toBe(true);
		expect(canActivate({ status: 'disabled', activeVersion: 3, latestVersion: 3 })).toBe(true);
	});
	test('version markers', () => {
		const s = { status: 'active' as const, activeVersion: 2, approval: approval('pending', 3) };
		expect(versionMarkers(2, s).map((m) => m.label)).toEqual(['active']);
		expect(versionMarkers(3, s).map((m) => m.label)).toEqual(['waits for approval']);
		expect(versionMarkers(1, s)).toEqual([]);
		expect(versionMarkers(2, { ...s, status: 'disabled' }).map((m) => m.label)).toEqual(['last active']);
	});
	test('names', () => {
		expect(SCRIPT_NAME.test('halo-forwarder')).toBe(true);
		expect(SCRIPT_NAME.test('Halo')).toBe(false);
		expect(SCRIPT_NAME.test('1abc')).toBe(false);
		expect(SCRIPT_NAME.test('a_b')).toBe(false);
	});
});

describe('runs', () => {
	test('durations, tones, call labels and short JSON', () => {
		expect(formatDuration(12.4)).toBe('12 ms');
		expect(formatDuration(1234)).toBe('1.23 s');
		expect(formatDuration(12_345)).toBe('12.3 s');
		expect(formatDuration(125_000)).toBe('2 min 5 s');
		expect(formatDuration(null)).toBe('—');
		expect(outcomeTone('ok')).toBe('success');
		expect(outcomeTone('skipped')).toBe('secondary');
		expect(outcomeTone('timeout')).toBe('destructive');
		expect(callLabel({ method: 'channels.send', dryRun: true })).toBe('would channels.send');
		expect(callLabel({ method: 'kv.get' })).toBe('kv.get');
		expect(shortJson({ a: 'x'.repeat(50) }, 10)).toBe('{"a":"xxxx…');
	});
});

describe('manifest', () => {
	test('the template passes', () => {
		const r = checkManifest(JSON.stringify(TEMPLATE_MANIFEST));
		expect(r.ok).toBe(true);
	});
	test('broken JSON says where', () => {
		const r = checkManifest('{\n  "triggers": [,]\n}');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toStartWith('Not valid JSON');
	});
	test('shape errors', () => {
		const err = (t: string): string => {
			const r = checkManifest(t);
			return r.ok ? '' : r.error;
		};
		expect(err('')).toContain('empty');
		expect(err('[]')).toContain('JSON object');
		expect(err('{"triggers": {}}')).toContain('list');
		expect(err('{"triggers": [{"kind": "nope"}]}')).toContain('Trigger 1');
		expect(err('{"grants": []}')).toContain('grants');
		expect(err('{"cooldownSec": -1}')).toContain('cooldownSec');
	});
	test('trigger summary', () => {
		expect(
			triggerSummary({
				triggers: [
					{ kind: 'channel', events: ['message.created'], chats: ['Ops'], textContains: ['halo'] },
					{ kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * *', timezone: 'Europe/Berlin' } },
					{ kind: 'schedule', spec: { kind: 'every', everyMs: 300_000 } },
					{ kind: 'table', table: 'members', events: ['row.created'] }
				]
			})
		).toEqual(['chat message.created in Ops with "halo"', 'cron 0 9 * * * (Europe/Berlin)', 'every 5 min', 'table members row.created']);
		expect(triggerSummary(undefined)).toEqual([]);
	});
});
