// The program editor's form <-> the API shapes. Pure.
import type { components } from '../api/schema';
import { buildSpec, defaultScheduleForm, parseSpec, type ScheduleForm } from '../routines/schedule';

export type Program = components['schemas']['Program'];
export type ProgramCreate = components['schemas']['ProgramCreate'];
export type ProgramPatch = components['schemas']['ProgramPatch'];
export type ProgramReportMode = Program['report'];
export type Deliverable = components['schemas']['Deliverable'];
export type DeliverableKind = Deliverable['kind'];

/** One deliverable as the editor holds it: text fields, parsed on save. */
export type DeliverableRow = {
	path: string;
	kind: DeliverableKind;
	/** Markdown: one heading per line. */
	sections: string;
	/** JSON: the JSON Schema as text. */
	schema: string;
	/** As typed; empty = no minimum. */
	minChars: string;
};

export const DELIVERABLE_KINDS: { value: DeliverableKind; label: string }[] = [
	{ value: 'markdown', label: 'Markdown' },
	{ value: 'json', label: 'JSON' },
	{ value: 'any', label: 'Any file' }
];

export const emptyDeliverableRow = (): DeliverableRow => ({ path: '', kind: 'markdown', sections: '', schema: '', minChars: '' });

export const rowFromDeliverable = (d: Deliverable): DeliverableRow => ({
	path: d.path,
	kind: d.kind,
	sections: joinLines(d.requiredSections ?? []),
	schema: d.schema === undefined ? '' : JSON.stringify(d.schema, null, 2),
	minChars: d.minChars === undefined ? '' : String(d.minChars)
});

/** A row in the API shape; `null` when it has a problem (see `validateDeliverables`). */
export function deliverableFromRow(r: DeliverableRow): Deliverable | null {
	const path = r.path.trim();
	if (path === '') return null;
	const out: Deliverable = { path, kind: r.kind };
	if (r.kind === 'markdown') {
		const sections = splitLines(r.sections);
		if (sections.length) out.requiredSections = sections;
	}
	if (r.kind === 'json' && r.schema.trim() !== '') {
		try {
			const schema = JSON.parse(r.schema);
			if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;
			out.schema = schema;
		} catch {
			return null;
		}
	}
	const n = r.minChars.trim();
	if (n !== '') {
		const min = Number(n);
		if (!Number.isInteger(min) || min < 1) return null;
		out.minChars = min;
	}
	return out;
}

const DELIVERABLE_TOKENS = ['date', 'slug', 'runId', 'program'];

const validMinChars = (text: string): boolean => text.trim() === '' || (Number.isInteger(Number(text)) && Number(text) >= 1);

function validSchemaText(text: string): boolean {
	if (text.trim() === '') return true;
	try {
		const v = JSON.parse(text);
		return typeof v === 'object' && v !== null && !Array.isArray(v);
	} catch {
		return false;
	}
}

/** Problems of the deliverable rows, by row index (`deliverables.<i>`). */
export function validateDeliverables(rows: readonly DeliverableRow[]): Record<string, string> {
	const errors: Record<string, string> = {};
	rows.forEach((r, i) => {
		const path = r.path.trim();
		const bad = [...path.matchAll(/\{([A-Za-z]+)\}/g)].find((m) => !DELIVERABLE_TOKENS.includes(m[1] as string));
		const problem =
			path === ''
				? 'Give the file a path, like /library/reports/{slug}/{date}.md.'
				: !path.startsWith('/') || path.includes('..') || path.endsWith('/')
					? `The path is a library file path starting with / (not "${path}").`
					: bad
						? `Unknown token {${bad[1]}}. Use ${DELIVERABLE_TOKENS.map((t) => `{${t}}`).join(', ')}.`
						: r.kind === 'json' && !validSchemaText(r.schema)
							? 'The schema must be a JSON object (a JSON Schema).'
							: !validMinChars(r.minChars)
								? 'The minimum length is a whole number above 0.'
								: '';
		if (problem) errors[`deliverables.${i}`] = problem;
	});
	return errors;
}

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
	/** Worker program: each run takes queued tasks of the agent (the work queue). */
	worker: boolean;
	/** Tasks per run, as typed. */
	maxTasks: string;
	/** Files each run must leave in the library (checked at run end). */
	deliverables: DeliverableRow[];
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
	report: 'task',
	worker: false,
	maxTasks: '3',
	deliverables: []
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
export type ProgramShape = Pick<Program, 'name' | 'brief' | 'authority' | 'gates' | 'forbidden' | 'escalation' | 'budget' | 'trigger' | 'report'> & { worker?: Program['worker']; deliverables?: Program['deliverables'] };

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
		report: p.report,
		worker: p.worker != null,
		maxTasks: String(p.worker?.maxTasks ?? 3),
		deliverables: (p.deliverables ?? []).map(rowFromDeliverable)
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
	if (f.worker) {
		const n = Number(f.maxTasks);
		if (!Number.isInteger(n) || n < 1 || n > 20) errors.maxTasks = 'Enter a whole number from 1 to 20.';
	}
	Object.assign(errors, validateDeliverables(f.deliverables));
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
		report: f.report,
		deliverables: f.deliverables.map(deliverableFromRow).filter((d): d is Deliverable => d !== null),
		worker: f.worker ? { maxTasks: Math.min(20, Math.max(1, Math.trunc(Number(f.maxTasks)) || 3)) } : null
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
