import { describe, expect, test } from 'bun:test';
import { acceptedText, driftText } from './drift';

describe('drift texts', () => {
	test('how many tools and chats', () => {
		expect(driftText({ tools: 13, sessions: 2 })).toBe('13 tools changed on the server since 2 chats pinned them');
		expect(driftText({ tools: 1, sessions: 1 })).toBe('1 tool changed on the server since a chat pinned it');
	});
	test('the result of accepting', () => {
		expect(acceptedText({ pinsCleared: 0, agents: 1, pending: false })).toContain('Nothing was pinned');
		expect(acceptedText({ pinsCleared: 3, agents: 1, pending: true })).toBe("Accepted the server's current definitions (3 chats). Busy chats reload right after their turn.");
	});
});
