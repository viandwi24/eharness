import { describe, expect, test } from 'bun:test';
import { describeChatError } from './errors.js';

describe('describeChatError', () => {
	test('the raw library text about unanswered items becomes one clear sentence, no retry', () => {
		const raw = 'Pending approvals, client tool calls or waits are still unanswered (missing: call_62afd748a881498db62a9158).';
		const p = describeChatError(new Error(raw), true);
		expect(p?.retry).toBeNull();
		expect(p?.message).toContain('waiting for your answer');
		expect(p?.message).not.toContain('call_62afd');
	});
	test('a stale answer is quiet', () => {
		expect(describeChatError(Object.assign(new Error('x'), { code: 'ALREADY_ANSWERED' }), false)).toBeNull();
	});
	test('busy and network failures retry only when following a server turn', () => {
		expect(describeChatError(Object.assign(new Error('x'), { code: 'EH_SESSION_BUSY' }), true)?.retry).toBe('follow');
		expect(describeChatError(Object.assign(new Error('x'), { code: 'EH_SESSION_BUSY' }), false)?.retry).toBeNull();
		expect(describeChatError(new TypeError('Failed to fetch'), true)).toEqual({ message: 'Cannot reach the server. Check your connection.', retry: 'follow' });
	});
	test('other messages are kept, clipped, with Retry for a server turn', () => {
		expect(describeChatError(new Error('Model failed'), true)).toEqual({ message: 'Model failed', retry: 'follow' });
		const long = describeChatError(new Error('x'.repeat(900)), false);
		expect(long?.message.length).toBeLessThanOrEqual(220);
		expect(describeChatError(undefined, false)?.message).toBe('Something went wrong while following the agent.');
	});
});
