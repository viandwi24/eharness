// The Decision Center's view model. Pure.
import type { components } from '../api/schema';
import { budgetSummary, type ProgramForm, bodyFromForm } from '../programs/form';
import { describeSpec } from '../routines/schedule';

export type Decision = components['schemas']['Decision'];
export type DecisionKind = Decision['kind'];
export type DecisionStatus = Decision['status'];
export type ApproveBody = components['schemas']['DecisionApprove'];
type Proposal = Extract<Decision, { kind: 'proposal' }>;
type Authority = components['schemas']['ProgramAuthority'];

/** Runs waiting come first: a parked run costs nothing but finishes nothing. */
export const KIND_ORDER: DecisionKind[] = ['escalation', 'amendment', 'proposal'];

export const KIND_INFO: Record<DecisionKind, { group: string; badge: string; hint: string }> = {
	escalation: { group: 'Questions from running work', badge: 'Question', hint: 'A run stopped and waits for your answer. It continues in the same conversation.' },
	amendment: { group: 'Requests for more authority', badge: 'More authority', hint: 'A run needs something it was not granted. Approving widens its program and resumes it.' },
	proposal: { group: 'Proposed plans', badge: 'Proposal', hint: 'Nothing starts until you approve. You can edit the authority first.' }
};

/** The open ones grouped by kind, in `KIND_ORDER`; empty groups are left out. */
export function groupDecisions(list: readonly Decision[]): { kind: DecisionKind; items: Decision[] }[] {
	return KIND_ORDER.map((kind) => ({ kind, items: list.filter((d) => d.kind === kind) })).filter((g) => g.items.length > 0);
}

/** Authority lines as a person reads them. */
export function authorityLines(a: Authority): string[] {
	return [
		...a.tools.map((t) => `Use ${t}`),
		...a.connectors.map((c) => `Every tool of connector ${c}`),
		...a.read.map((g) => `Read ${g}`),
		...a.write.map((g) => `Read and write ${g}`)
	];
}

/** What approving this decision grants: a list that is empty when approving grants nothing. */
export function grantLines(d: Decision): string[] {
	if (d.kind === 'proposal') return authorityLines(d.payload.program.authority);
	if (d.kind === 'amendment') return authorityLines(d.payload.authority);
	return [];
}

/** When a proposal would run. */
export function triggerLine(p: Proposal['payload']): string {
	if (p.runOnce) return 'Runs once, right after you approve';
	const t = p.program.trigger;
	return t.kind === 'schedule' ? `Runs ${describeSpec(t.spec).toLowerCase()}` : 'Runs when you run it';
}

/** Budget of a proposal as one line. */
export const proposalBudget = (p: Proposal['payload']): string => budgetSummary(p.program.budget);

/** What the card says it is about, in the bell and in the list. */
export function decisionText(d: Decision, agentName: string): string {
	if (d.kind === 'proposal') return `${agentName} proposes: ${d.title}`;
	if (d.kind === 'amendment') return `${agentName} asks for more authority: ${d.title}`;
	return `${agentName} needs a decision: ${d.title}`;
}

export const isOpen = (d: Pick<Decision, 'status'>): boolean => d.status === 'open';

/** Escalations with options ask for a pick; the others for approve or reject. */
export const optionsOf = (d: Decision): string[] => (d.kind === 'escalation' ? d.payload.options : []);

/** One word for a decided card. */
export function statusBadge(d: Pick<Decision, 'status'>): { label: string; variant: 'warning' | 'success' | 'secondary' | 'destructive' } {
	if (d.status === 'open') return { label: 'Waiting for you', variant: 'warning' };
	if (d.status === 'approved') return { label: 'Approved', variant: 'success' };
	if (d.status === 'rejected') return { label: 'Rejected', variant: 'secondary' };
	return { label: 'Expired', variant: 'destructive' };
}

/** What a decided card says happened. */
export function outcomeLine(d: Decision): string {
	if (d.status === 'open') return '';
	if (d.status === 'expired') return 'The run no longer waited for this.';
	const o = d.outcome;
	if (d.status === 'rejected') return d.kind === 'proposal' ? 'Rejected: nothing was created.' : 'Rejected: the run continued without it.';
	if (d.kind === 'proposal') {
		if (o?.runSessionId) return 'Approved: the program was created and a run started.';
		return o?.programId ? 'Approved: the program was created.' : 'Approved.';
	}
	if (d.kind === 'amendment') return 'Approved: the authority was added and the run continued.';
	return o?.decision && o.decision !== 'approved' ? `Answered "${o.decision}": the run continued.` : 'Approved: the run continued.';
}

/** The body of "Edit & approve": what the client changed in the program form (the agent stays). */
export function editBody(form: ProgramForm, runOnce: boolean): NonNullable<ApproveBody['edit']> {
	const { name, brief, authority, gates, forbidden, escalation, budget, trigger, report, deliverables } = bodyFromForm(form);
	return { program: { name, brief, authority, gates, forbidden, escalation, budget, trigger, report, deliverables }, runOnce };
}

/** The decision a refresh returned in place of `id`, or the list without it: used after an answer. */
export function withoutDecision(list: readonly Decision[], id: string): Decision[] {
	return list.filter((d) => d.id !== id);
}

/** Same words as the server's stand-down check: an answer like this is remembered for a week for a program's escalation. */
export const isStandDownChoice = (choice: string): boolean =>
	/\b(keep\s+waiting|wait|hold|skip|ignore|dismiss|snooze|not\s+now|later|no\s+action|leave\s+(it|as)|do\s+nothing|don'?t\s+(escalate|ask)|continue\s+waiting)\b/i.test(choice);

/** The remembered subject as people read it: record ids (`AB-12`) stay, a slugged title does not. */
export const readableSubject = (subject: string): string => (/^[A-Z]{1,6}-\d{1,6}(,[A-Z]{1,6}-\d{1,6})*$/.test(subject) ? subject.replace(/,/g, ', ') : '');
