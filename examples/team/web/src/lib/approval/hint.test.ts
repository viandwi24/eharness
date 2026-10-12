import { describe, expect, test } from 'bun:test';
import type { Approval } from '../api/client.js';
import { declineHint } from './hint.js';

const a = (id: string, toolName: string, kind: 'approval' | 'question' = 'approval'): Approval => ({ id, kind, toolName }) as Approval;

describe('declineHint', () => {
	test('nothing pending, nothing to say', () => {
		expect(declineHint([])).toBeUndefined();
		expect(declineHint([a('q', 'ask_user_question', 'question')])).toBeUndefined();
	});
	test('counts approvals and names the tools', () => {
		const h = declineHint([a('1', 'web_search'), a('2', 'web_search'), a('3', 'write_file')])!;
		expect(h.count).toBe(3);
		expect(h.text).toBe('Sending will decline 3 pending approvals (web_search ×2, write_file)');
		expect(declineHint([a('1', 'bash')])!.text).toBe('Sending will decline 1 pending approval (bash)');
		expect(declineHint([a('1', 'bash')], 2)!.text).toBe('Sending will decline 1 pending approval (bash); 2 from delegated agents stay open');
		expect(declineHint([], 2)).toBeUndefined();
	});
});
