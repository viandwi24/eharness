// The Decision Center's view model. Pure.
import type { components } from '../api/schema';
import { budgetSummary, type ProgramForm, bodyFromForm } from '../programs/form';
import { describeScheduleWords } from '../routines/schedule';

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
	if (d.kind === 'proposal') return mayTouchLines(d.payload.program.authority);
	if (d.kind === 'amendment') return mayTouchLines(d.payload.authority);
	return [];
}

const lowerFirst = (t: string): string => (t.startsWith('On a custom') ? t : `${t[0]!.toLowerCase()}${t.slice(1)}`);

const BUILTIN_WORDS: Record<string, string> = {
	read_file: 'read files',
	list_files: 'list files',
	grep: 'search inside files',
	glob: 'find files by name',
	write_file: 'write files',
	edit_file: 'edit files',
	web_search: 'search the web',
	web_fetch: 'open web pages',
	run_code: 'run code'
};

const words = (id: string): string => id.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A tool id in plain words: `read_file` is "read files", `tracker__list_issues` is "list issues (tracker)". */
export function toolWords(id: string): string {
	if (BUILTIN_WORDS[id]) return BUILTIN_WORDS[id]!;
	const [first, ...rest] = id.split('__');
	if (rest.length > 0) return `${words(rest.join(' '))} (${words(first!)})`;
	return words(id);
}

/** What a proposal's program "may touch", in plain language (no tool ids, no raw globs where a sentence does). */
export function mayTouchLines(a: Authority): string[] {
	const path = (g: string): string => (g.endsWith('/**') ? `everything under ${g.slice(0, -3) || '/'}` : g);
	return [
		...a.tools.map((t) => `Can ${toolWords(t)}`),
		...a.connectors.map((c) => `Can use the ${words(c)} connection`),
		...a.read.map((g) => `Can read ${path(g)}`),
		...a.write.map((g) => `Can read and change ${path(g)}`)
	];
}

/** The "will not touch" side: what the proposal forbids, in plain language. */
export function willNotTouchLines(p: Proposal['payload']): string[] {
	return p.program.forbidden.map((f) => `Will not ${/^[A-Za-z_]+$/.test(f) ? toolWords(f) : f}`);
}

/** A body the agent wrote, without sentences that send the reader to the Decision Center: they are already in it. */
export function cleanBody(body: string): string {
	return body
		.split('\n')
		.map((line) => line.replace(/(?:^|(?<=[.!?]\s))[^.!?\n]*\bin the Decision Center\b[^.!?\n]*[.!?]?\s*/gi, '').trimEnd())
		.filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
		.join('\n')
		.trim();
}

/** When a proposal would run. */
export function triggerLine(p: Proposal['payload']): string {
	if (p.runOnce) return 'Runs once, right after you approve';
	const t = p.program.trigger;
	return t.kind === 'schedule' ? `Runs ${lowerFirst(describeScheduleWords(t.spec))}` : 'Runs when you run it';
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

/** The options of an escalation that a standing program remembers (the server decides: flagged by the agent or on its word list). */
export const standDownOptions = (d: Decision): string[] => (d.kind === 'escalation' ? (d.payload.standDown ?? []) : []);

/** The remembered subject as people read it: record ids (`AB-12`) stay, a slugged title does not. */
export const readableSubject = (subject: string): string => (/^[A-Z]{1,6}-\d{1,6}(,[A-Z]{1,6}-\d{1,6})*$/.test(subject) ? subject.replace(/,/g, ', ') : '');
