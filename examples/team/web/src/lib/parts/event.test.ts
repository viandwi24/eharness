import { describe, expect, test } from 'bun:test';
import { discussCard, proposalOutcomeCard } from './event.js';

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

describe('proposalOutcomeCard', () => {
	test('turns the seeded outcome into a readable card', () => {
		const text = 'The client approved your proposal "Weekly report".\nThe client\'s note (their own words): looks good\nIt is now a program; follow it on the Programs page.';
		expect(proposalOutcomeCard('decision.proposal.approved', text)).toEqual({
			label: 'Proposal approved',
			title: 'Weekly report',
			body: 'Your note: looks good\n\nIt is now a program: follow it on the Programs page.'
		});
		const no = proposalOutcomeCard('decision.proposal.rejected', 'The client rejected your proposal "X".\nNothing was created. Do not propose it again unless asked.');
		expect(no?.label).toBe('Proposal rejected');
		expect(no?.body).toBe('Nothing was created.');
		expect(proposalOutcomeCard('other.event', 'x')).toBeUndefined();
	});
});
