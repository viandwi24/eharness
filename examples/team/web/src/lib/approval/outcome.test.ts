import { describe, expect, test } from 'bun:test';
import { HarnessHttpError } from 'eharness/client';
import { answerFailureText } from './outcome.js';

describe('failed answers', () => {
	test('404 and EH_HTTP_ALREADY_ANSWERED are quiet: the item is gone', () => {
		expect(answerFailureText(new HarnessHttpError(404, 'NOT_FOUND', 'approval not found'))).toBeNull();
		expect(answerFailureText(new HarnessHttpError(409, 'EH_HTTP_ALREADY_ANSWERED', 'x'))).toBeNull();
	});
	test('a busy agent is a short retry hint, other errors keep their message', () => {
		expect(answerFailureText(new HarnessHttpError(409, 'EH_SESSION_BUSY', 'raw'))).toBe('The agent is busy right now. Try again in a moment.');
		expect(answerFailureText(new HarnessHttpError(400, 'EH_HTTP_INVALID_BODY', 'Invalid answer'))).toBe('Invalid answer');
		expect(answerFailureText(new Error(''))).toBe('Could not send the answer');
		expect(answerFailureText('boom')).toBe('Could not send the answer');
	});
});
