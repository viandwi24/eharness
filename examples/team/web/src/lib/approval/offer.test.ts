import type { UIMessage } from 'ai';
import { describe, expect, test } from 'bun:test';
import { requestedApprovalIds, shownChatStatus } from './offer.js';

describe('requestedApprovalIds', () => {
	test('collects approval-requested tool parts of assistant messages only', () => {
		const messages = [
			{ id: '1', role: 'user', parts: [{ type: 'text', text: 'x' }] },
			{
				id: '2',
				role: 'assistant',
				parts: [
					{ type: 'tool-write', state: 'approval-requested', approval: { id: 'a1' } },
					{ type: 'tool-write', state: 'output-available', approval: { id: 'a0' } }
				]
			}
		] as unknown as UIMessage[];
		expect(requestedApprovalIds(messages)).toEqual(['a1']);
	});
});

describe('shownChatStatus', () => {
	test('a failed request leaves the composer idle, other statuses pass through', () => {
		expect(shownChatStatus('error')).toBe('ready');
		expect(shownChatStatus('streaming')).toBe('streaming');
		expect(shownChatStatus('submitted')).toBe('submitted');
		expect(shownChatStatus('ready')).toBe('ready');
	});
});
