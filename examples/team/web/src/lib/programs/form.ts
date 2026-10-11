// The program editor's form <-> the API shapes. Pure.
import type { components } from '../api/schema';
import { buildSpec, defaultScheduleForm, parseSpec, type ScheduleForm } from '../routines/schedule';

export type Program = components['schemas']['Program'];
export type ProgramCreate = components['schemas']['ProgramCreate'];
export type ProgramPatch = components['schemas']['ProgramPatch'];
export type ProgramReportMode = Program['report'];

export type ProgramForm = {
	name: string;
	brief: string;
	/** One entry per line. */
	tools: string;
	connectors: string;
	read: string;
	write: string;
	gates: string;
	forbidden: string;
	escalation: string;
	/** USD as typed; empty = no limit. */
	perRunUsd: string;
	perDayUsd: string;
	triggerKind: 'manual' | 'schedule';
	schedule: ScheduleForm;
	report: ProgramReportMode;
};

export const REPORT_OPTIONS: { value: ProgramReportMode; label: string; hint: string }[] = [
	{ value: 'task', label: 'As a task on the board', hint: 'Each run shows on the board with its report.' },
	{ value: 'digest', label: 'In the daily digest', hint: 'One line per run in your digest.' },
	{ value: 'silent', label: 'Silent', hint: 'Only the run history.' }
];

export const emptyProgramForm = (): ProgramForm => ({
	name: '',
	brief: '',
	tools: '',
	connectors: '',
	read: '',
	write: '',
	gates: '',
	forbidden: '',
	escalation: '',
	perRunUsd: '',
	perDayUsd: '',
	triggerKind: 'manual',
	schedule: defaultScheduleForm(),
	report: 'task'
});

/** One entry per non-empty line, trimmed, without duplicates. */
export const splitLines = (text: string): string[] => [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l !== ''))];

export const joinLines = (items: readonly string[]): string => items.join('\n');

/** A budget field: empty is "no limit"; otherwise a positive number (`null` when it is not valid). */
export function parseUsd(text: string): number | null | 'invalid' {
	const t = text.trim();
	if (t === '') return null;
	const n = Number(t);
	return Number.isFinite(n) && n > 0 ? n : 'invalid';
}

/** The fields of a program the form edits: a stored program or a proposed one. */
export type ProgramShape = Pick<Program, 'name' | 'brief' | 'authority' | 'gates' | 'forbidden' | 'escalation' | 'budget' | 'trigger' | 'report'>;

export function formFromProgram(p: ProgramShape, fallbackTz?: string): ProgramForm {
	return {
		name: p.name,
		brief: p.brief,
		tools: joinLines(p.authority.tools),
		connectors: joinLines(p.authority.connectors),
		read: joinLines(p.authority.read),
		write: joinLines(p.authority.write),
		gates: joinLines(p.gates),
		forbidden: joinLines(p.forbidden),
		escalation: p.escalation,
		perRunUsd: p.budget.perRunUsd === null ? '' : String(p.budget.perRunUsd),
		perDayUsd: p.budget.perDayUsd === null ? '' : String(p.budget.perDayUsd),
		triggerKind: p.trigger.kind,
		schedule: p.trigger.kind === 'schedule' ? parseSpec(p.trigger.spec, fallbackTz) : defaultScheduleForm(fallbackTz),
		report: p.report
	};
}

/** Problems the form can find without the server (field -> message). */
export function validateProgramForm(f: ProgramForm): Record<string, string> {
	const errors: Record<string, string> = {};
	if (f.name.trim() === '') errors.name = 'Give the program a name.';
	if (f.brief.trim() === '') errors.brief = 'Describe what the agent should do.';
	for (const [field, label] of [['read', 'Read'], ['write', 'Write']] as const) {
		const bad = splitLines(f[field]).find((g) => !g.startsWith('/') || g.includes('..'));
		if (bad !== undefined) errors[field] = `${label} paths are library globs starting with /, like /library/reports/** (not "${bad}").`;
	}
	if (parseUsd(f.perRunUsd) === 'invalid') errors.perRunUsd = 'Enter an amount above 0, or leave it empty.';
	if (parseUsd(f.perDayUsd) === 'invalid') errors.perDayUsd = 'Enter an amount above 0, or leave it empty.';
	return errors;
}

/** The authority, gates, forbidden, budget, trigger and report of a form, in the API shape. */
export function bodyFromForm(f: ProgramForm): Omit<ProgramCreate, 'agentId'> {
	const perRun = parseUsd(f.perRunUsd);
	const perDay = parseUsd(f.perDayUsd);
	return {
		name: f.name.trim(),
		brief: f.brief.trim(),
		authority: {
			tools: splitLines(f.tools),
			connectors: splitLines(f.connectors),
			read: splitLines(f.read),
			write: splitLines(f.write)
		},
		gates: splitLines(f.gates),
		forbidden: splitLines(f.forbidden),
		escalation: f.escalation.trim(),
		budget: { perRunUsd: perRun === 'invalid' ? null : perRun, perDayUsd: perDay === 'invalid' ? null : perDay },
		trigger: f.triggerKind === 'manual' ? { kind: 'manual' } : { kind: 'schedule', spec: buildSpec(f.schedule) },
		report: f.report
	};
}

export type ProgramBadge = { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' };

/** Status badge of a program: its own pause, or what its schedule trigger is doing. */
export function programBadge(p: Pick<Program, 'status' | 'triggerState'>): ProgramBadge {
	if (p.status === 'paused') return { label: 'paused', variant: 'secondary' };
	const t = p.triggerState;
	if (t?.status === 'paused') {
		return t.pausedReason === 'max-failures'
			? { label: 'paused: too many failures', variant: 'destructive' }
			: { label: t.pausedReason === 'ended' || t.pausedReason === 'completed' ? 'finished' : 'paused', variant: 'secondary' };
	}
	if (t !== null && t.failures > 0) return { label: `active, ${t.failures} failed`, variant: 'warning' };
	return { label: 'active', variant: 'success' };
}

/** What a run's report says in one word, for the run history. */
export const REPORT_LABELS: Record<NonNullable<components['schemas']['Task']['report']>['status'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'info' }> = {
	done: { label: 'done', variant: 'success' },
	partial: { label: 'partial', variant: 'warning' },
	failed: { label: 'failed', variant: 'destructive' },
	needs_decision: { label: 'needs a decision', variant: 'info' }
};

/** Short text of the authority for the list: what the program may touch. */
export function authoritySummary(a: Program['authority']): string {
	const parts: string[] = [];
	if (a.tools.length) parts.push(`${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}`);
	if (a.connectors.length) parts.push(`${a.connectors.length} connector${a.connectors.length === 1 ? '' : 's'}`);
	if (a.read.length) parts.push(`read ${a.read.length}`);
	if (a.write.length) parts.push(`write ${a.write.length}`);
	return parts.length ? parts.join(', ') : 'nothing granted';
}

/** Budget as one line: "$2 / run, $10 / day", or "no limit". */
export function budgetSummary(b: Program['budget']): string {
	const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : String(Number(n.toFixed(2)))}`;
	const parts: string[] = [];
	if (b.perRunUsd !== null) parts.push(`${usd(b.perRunUsd)} / run`);
	if (b.perDayUsd !== null) parts.push(`${usd(b.perDayUsd)} / day`);
	return parts.length ? parts.join(', ') : 'no limit';
}
