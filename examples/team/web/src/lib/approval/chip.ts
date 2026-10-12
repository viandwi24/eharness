// The status chip a tool row shows for a call that needed an approval. The approval itself lives in
// the dock above the composer; the message only says where it stands. Pure, unit-tested.
import type { ToolApproval, ToolViewState } from '../parts/map.js';

export type ApprovalChip =
	| { kind: 'waiting'; text: string }
	| { kind: 'approved'; text: string }
	| { kind: 'declined'; text: string; note?: string }
	| { kind: 'elsewhere'; text: string }
	| { kind: 'answered'; text: string };

/** What the chat knows about an approval id: still listed, answered by this tab, or neither. */
export type ApprovalStanding = 'open' | 'approved-here' | 'declined-here' | 'elsewhere' | 'answered';

const NEW_INPUT = /sent a new message/i;

export function approvalChip(v: { state: ToolViewState; approval?: ToolApproval }, standing: ApprovalStanding = 'open'): ApprovalChip | undefined {
	const a = v.approval;
	if (!a) return undefined;
	if (v.state === 'approval-requested') {
		if (standing === 'open') return { kind: 'waiting', text: 'Waiting for your approval' };
		if (standing === 'elsewhere') return { kind: 'elsewhere', text: 'Answered elsewhere' };
		if (standing === 'approved-here') return { kind: 'approved', text: 'Approved' };
		if (standing === 'declined-here') return { kind: 'declined', text: 'Declined' };
		return { kind: 'answered', text: 'Answered' };
	}
	if (v.state === 'output-denied' || a.approved === false) {
		const reason = a.reason?.trim();
		if (reason && NEW_INPUT.test(reason)) return { kind: 'declined', text: 'Declined: you sent a new message' };
		return { kind: 'declined', text: 'Declined', ...(reason ? { note: reason } : {}) };
	}
	// A call the permission rules let through (a read, a saved rule, the mode) was never asked: the
	// server marks it (`metadata.app.autoAllowed`), so say so instead of "Approved".
	if (a.auto) return { kind: 'approved', text: 'Auto-allowed' };
	return { kind: 'approved', text: 'Approved' };
}

/**
 * Where an approval shown in the chat stands. It is "answered elsewhere" only when this tab did not
 * answer it and a refresh made after the row appeared still does not list it (the list lags the
 * stream, and a failed earlier turn must not matter).
 */
export function standingOf(o: { answeredHere: 'approved' | 'declined' | undefined; listLoaded: boolean; inList: boolean; confirmedGone: boolean }): ApprovalStanding {
	if (o.answeredHere) return o.answeredHere === 'approved' ? 'approved-here' : 'declined-here';
	if (!o.listLoaded || o.inList) return 'open';
	return o.confirmedGone ? 'elsewhere' : 'open';
}
