import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api/client';
import { answerFailureText, isAlreadyAnswered } from './outcome.js';

describe('failed answers', () => {
	test('404 and 409 ALREADY_ANSWERED are quiet: the item is gone', () => {
		expect(isAlreadyAnswered(new ApiError(404, 'NOT_FOUND', 'approval not found'))).toBe(true);
		expect(isAlreadyAnswered(new ApiError(409, 'ALREADY_ANSWERED', 'x'))).toBe(true);
		expect(answerFailureText(new ApiError(404, 'NOT_FOUND', 'x'))).toBeNull();
		expect(answerFailureText(new ApiError(409, 'ALREADY_ANSWERED', 'x'))).toBeNull();
	});
	test('a busy agent is a short retry hint, other errors keep their message', () => {
		expect(answerFailureText(new ApiError(409, 'EH_SESSION_BUSY', 'raw'))).toBe('The agent is busy right now. Try again in a moment.');
		expect(answerFailureText(new ApiError(400, 'EH_INVALID_INPUT', 'Invalid answer'))).toBe('Invalid answer');
		expect(isAlreadyAnswered(new ApiError(409, 'CONFLICT', 'x'))).toBe(false);
		expect(answerFailureText(new Error(''))).toBe('Could not send the answer');
		expect(answerFailureText('boom')).toBe('Could not send the answer');
	});
});
