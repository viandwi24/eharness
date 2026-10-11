import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { interruptedTurn } from './interrupted.js';

const msg = (id: string, role: 'user' | 'assistant', eharness: Record<string, unknown> = {}): UIMessage =>
	({ id, role, parts: [{ type: 'text', text: id }], metadata: { eharness: { v: 1, ...eharness } } }) as UIMessage;

describe('interruptedTurn', () => {
	test('the last reply stopped interrupted, a recovery notice after it does not hide it', () => {
		const a = msg('a', 'assistant', { stop: 'interrupted' });
		expect(interruptedTurn([msg('u', 'user'), a, msg('n', 'user', { kind: 'eh.notice' })])).toBe(a);
	});
	test('a user message or a newer reply after it hides the offer', () => {
		const a = msg('a', 'assistant', { stop: 'interrupted' });
		expect(interruptedTurn([a, msg('u2', 'user')])).toBeUndefined();
		expect(interruptedTurn([a, msg('b', 'assistant', { stop: 'complete' })])).toBeUndefined();
	});
	test('a user message that was never answered is not an interruption', () => {
		expect(interruptedTurn([msg('u', 'user')])).toBeUndefined();
		expect(interruptedTurn([])).toBeUndefined();
	});
});
