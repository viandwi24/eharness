import { describe, expect, test } from 'bun:test';
import { unwrapText } from './unwrap';

describe('unwrapText', () => {
	test('joins hard-wrapped lines of a paragraph', () => {
		expect(unwrapText('You are working on\na task for the team.\n\nSecond paragraph\nhere.')).toBe('You are working on a task for the team.\n\nSecond paragraph here.');
	});
	test('keeps list items, headings and code fences', () => {
		const t = '# Title\n- one\n- two\n```\na\nb\n```\nafter\ntext';
		expect(unwrapText(t)).toBe('# Title\n- one\n- two\n```\na\nb\n```\nafter text');
	});
});
