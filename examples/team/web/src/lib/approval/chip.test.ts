import { describe, expect, test } from 'bun:test';
import { approvalChip, standingOf } from './chip.js';

describe('approvalChip', () => {
	test('no approval, no chip', () => {
		expect(approvalChip({ state: 'output-available' })).toBeUndefined();
	});
	test('waiting while the dock lists it; elsewhere or just answered otherwise', () => {
		const v = { state: 'approval-requested', approval: { id: 'a' } } as const;
		expect(approvalChip(v, 'open')).toEqual({ kind: 'waiting', text: 'Waiting for your approval' });
		expect(approvalChip(v, 'elsewhere')).toEqual({ kind: 'elsewhere', text: 'Answered elsewhere' });
		expect(approvalChip(v, 'approved-here')).toEqual({ kind: 'approved', text: 'Approved' });
		expect(approvalChip(v, 'declined-here')?.text).toBe('Declined');
		expect(approvalChip(v, 'answered')?.kind).toBe('answered');
	});
	test('approved and declined, with the note or the new-message reason', () => {
		expect(approvalChip({ state: 'output-available', approval: { id: 'a', approved: true } })?.text).toBe('Approved');
		expect(approvalChip({ state: 'output-denied', approval: { id: 'a', approved: false, reason: 'use draft' } })).toEqual({ kind: 'declined', text: 'Declined', note: 'use draft' });
		expect(approvalChip({ state: 'output-denied', approval: { id: 'a', approved: false, reason: 'The user sent a new message instead of answering.' } })?.text).toBe('Declined: you sent a new message');
	});
});

describe('standingOf', () => {
	const base = { answeredHere: undefined as 'approved' | 'declined' | undefined, listLoaded: true, inList: false, confirmedGone: false };
	test('answered here wins; unlisted counts as elsewhere only once confirmed', () => {
		expect(standingOf({ ...base, answeredHere: 'approved', confirmedGone: true })).toBe('approved-here');
		expect(standingOf({ ...base, answeredHere: 'declined' })).toBe('declined-here');
		expect(standingOf(base)).toBe('open');
		expect(standingOf({ ...base, confirmedGone: true })).toBe('elsewhere');
		expect(standingOf({ ...base, inList: true, confirmedGone: true })).toBe('open');
		expect(standingOf({ ...base, listLoaded: false, confirmedGone: true })).toBe('open');
	});
});
