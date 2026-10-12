import { describe, expect, test } from 'bun:test';
import { discussCard } from './event.js';

describe('discussCard', () => {
	test('splits the seed into a title and its context', () => {
		const c = discussCard('discuss.briefing', 'The client opened this chat to talk about a briefing item: Overdue tasks\n\nT-05 is blocked.\nT-01 is late.');
		expect(c).toEqual({ label: 'Discussing a briefing item', title: 'Overdue tasks', body: 'T-05 is blocked.\nT-01 is late.' });
	});
	test('other events and unknown texts', () => {
		expect(discussCard('subagent.report', 'x')).toBeUndefined();
		expect(discussCard('discuss.run', 'free text')).toEqual({ label: 'Discussing a run', title: '', body: 'free text' });
	});
});
