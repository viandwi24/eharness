import { HarnessHttpError } from 'eharness/client';
import { describe, expect, test } from 'bun:test';
import { errorHint, lastTurnErrorCode, requestFailureText } from './errors.js';

describe('errorHint', () => {
	test('names the fix for a rejected key and a down lock service', () => {
		expect(errorHint('EH_PROVIDER_AUTH')).toContain('Settings > Providers');
		expect(errorHint('EH_LOCK_UNAVAILABLE')).toContain('Storage is unavailable');
		expect(errorHint('EH_RUN_FAILED')).toBeUndefined();
	});
});

describe('requestFailureText', () => {
	test('uses the hint of the code, else the message', () => {
		expect(requestFailureText(new HarnessHttpError(502, 'EH_PROVIDER_AUTH', 'x'), 'f')).toContain('API key');
		expect(requestFailureText(new HarnessHttpError(409, 'EH_SESSION_BUSY', 'busy now'), 'f')).toBe('busy now');
		expect(requestFailureText('nope', 'fallback')).toBe('fallback');
	});
});

describe('lastTurnErrorCode', () => {
	test('reads the stored error code of the last assistant message', () => {
		const messages = [
			{ id: '1', role: 'user', parts: [] },
			{ id: '2', role: 'assistant', parts: [], metadata: { eharness: { error: { code: 'EH_PROVIDER_AUTH', message: 'm' } } } }
		] as never;
		expect(lastTurnErrorCode(messages)).toBe('EH_PROVIDER_AUTH');
		expect(lastTurnErrorCode([] as never)).toBeUndefined();
	});
});
