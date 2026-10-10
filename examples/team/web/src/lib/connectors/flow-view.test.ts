import { describe, expect, test } from 'bun:test';
import type { ConnectFlow, Connection, FlowView } from '../api/client';
import type { FormField } from '../providers/form';
import { choosePayload, chooseError, countdownText, deviceLink, flowSucceeded, formPayload, toggleSelected, viewTitle } from './flow-view';

const f = (over: Partial<FormField> & { path: string }): FormField => ({ kind: 'string', label: over.path, required: false, secret: false, secretValues: false, group: 'auth', ...over });
const flow = (status: ConnectFlow['status']): ConnectFlow => ({ id: 'f', definitionId: 'd', scope: 'workspace', label: 'x', status, step: 's', rev: 1, view: { type: 'status', viewId: 'v', step: 's', state: 'success', message: 'ok' }, createdAt: 0, updatedAt: 0, expiresAt: 0 });

describe('formPayload', () => {
	const fields = [f({ path: 'token', label: 'Token', secret: true, required: true }), f({ path: 'site', label: 'Site', required: true })];
	test('an empty stored secret is kept', () => {
		const r = formPayload(fields, { token: '', site: ' a.com ' }, { token: { set: true, hint: '••12' } });
		expect(r).toEqual({ ok: true, data: { site: 'a.com', token: { keep: true } } });
	});
	test('a new secret is sent', () => {
		const r = formPayload(fields, { token: 'abc', site: 'a' }, {});
		expect(r).toEqual({ ok: true, data: { token: 'abc', site: 'a' } });
	});
	test('required fields report errors', () => {
		const r = formPayload(fields, { token: '', site: '' }, {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['site', 'token']);
	});
});

describe('choose', () => {
	const view = { type: 'choose', viewId: 'v', step: 's', title: 't', options: [], multiple: true, selected: [], min: 2 } as Extract<FlowView, { type: 'choose' }>;
	test('payload and toggling', () => {
		expect(choosePayload(['a'])).toEqual({ selected: ['a'] });
		expect(toggleSelected(['a'], 'b', true)).toEqual(['a', 'b']);
		expect(toggleSelected(['a', 'b'], 'a', true)).toEqual(['b']);
		expect(toggleSelected(['a'], 'b', false)).toEqual(['b']);
	});
	test('min and single validation', () => {
		expect(chooseError(view, ['a'])).toBe('Choose at least 2.');
		expect(chooseError(view, ['a', 'b'])).toBeUndefined();
		expect(chooseError({ ...view, multiple: false }, [])).toBe('Choose one option.');
	});
});

describe('misc', () => {
	test('flowSucceeded needs done and a connection', () => {
		const c = { id: 'c' } as Connection;
		expect(flowSucceeded(flow('done'), c)).toBe(true);
		expect(flowSucceeded(flow('done'), null)).toBe(false);
		expect(flowSucceeded(flow('failed'), c)).toBe(false);
		expect(flowSucceeded(null, c)).toBe(false);
	});
	test('titles', () => {
		expect(viewTitle({ type: 'error', viewId: 'v', step: 's', message: 'm', retryable: true })).toBe('Something went wrong');
		expect(viewTitle({ type: 'status', viewId: 'v', step: 's', state: 'success', message: 'm' })).toBe('Connected');
	});
	test('countdown', () => {
		expect(countdownText(1000, 2000)).toBe('Expired');
		expect(countdownText(31_000, 1000)).toBe('Expires in 30 sec');
		expect(countdownText(1000 + 4 * 60_000 - 5, 1000)).toBe('Expires in 4 min');
	});
	test('device link prefers the complete url', () => {
		const v = { type: 'deviceCode', viewId: 'v', step: 's', title: 't', userCode: 'A', verificationUrl: 'https://a', expiresAt: 0, pollIntervalMs: 1000 } as const;
		expect(deviceLink(v)).toBe('https://a');
		expect(deviceLink({ ...v, verificationUrlComplete: 'https://b' })).toBe('https://b');
	});
});
