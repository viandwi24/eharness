import { describe, expect, test } from 'bun:test';
import { connectionStatus, profileStatuses, runTest, STATUS_BADGE, testSummary, visibleStatusMessage } from './status';

describe('shared status vocabulary', () => {
	test('connection status', () => {
		expect(connectionStatus({ enabled: false, status: 'connected' })).toBe('off');
		expect(connectionStatus({ enabled: true, status: 'needs-auth' })).toBe('needs-auth');
		expect(connectionStatus({ enabled: true, status: 'error' })).toBe('error');
		expect(connectionStatus({ enabled: true, status: 'connected' })).toBe('connected');
		expect(STATUS_BADGE['needs-auth'].label).toBe('Reconnect needed');
	});

	test('profile badges', () => {
		expect(profileStatuses({ source: 'env', enabled: true, isDefault: true })).toEqual(['env', 'default']);
		expect(profileStatuses({ source: 'store', enabled: false })).toEqual(['custom', 'disabled']);
	});

	test('one summary line for providers and connections', () => {
		expect(testSummary({ ok: true })).toBe('Connected');
		expect(testSummary({ ok: true, message: 'Found 3 tools.', latencyMs: 120 })).toBe('Connected: Found 3 tools. (120 ms)');
		expect(testSummary({ ok: true, tools: 4 })).toBe('Connected (4 tools)');
		expect(testSummary({ ok: false })).toBe('Connection failed');
		expect(testSummary({ ok: false, message: 'Bad key' })).toBe('Bad key');
	});

	test('runTest turns a thrown error into a failed outcome', async () => {
		expect(await runTest(async () => ({ ok: true }))).toEqual({ ok: true });
		expect(await runTest(async () => Promise.reject(new Error('boom')))).toEqual({ ok: false, message: 'boom' });
	});
});

describe('visibleStatusMessage', () => {
	test('a test result that says the same hides the stored message', () => {
		expect(visibleStatusMessage('error', 'Could not reach it', { ok: false, message: 'Could not reach it' })).toBeUndefined();
		expect(visibleStatusMessage('error', 'Could not reach it', { ok: false, message: 'Could not reach the server: Could not reach it' })).toBeUndefined();
	});
	test('shown when nothing else says it; never for a connected one', () => {
		expect(visibleStatusMessage('error', 'Could not reach it')).toBe('Could not reach it');
		expect(visibleStatusMessage('error', 'x', { ok: false, busy: true })).toBe('x');
		expect(visibleStatusMessage('connected', 'old')).toBeUndefined();
	});
});
