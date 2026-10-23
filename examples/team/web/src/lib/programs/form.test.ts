import { describe, expect, test } from 'bun:test';
import {
	authoritySummary,
	lastStatusText,
	bodyFromForm,
	checkFromForm,
	parseOutputCap,
	warningsOf,
	budgetSummary,
	emptyProgramForm,
	formFromProgram,
	parseUsd,
	programBadge,
	splitLines,
	deliverableFromRow,
	emptyDeliverableRow,
	validateDeliverables,
	validateProgramForm,
	type Program
} from './form';

const program: Program = {
	id: 'p1',
	agentId: 'a1',
	name: 'Weekly summary',
	brief: 'Write a script for every new title.',
	briefPath: null,
	notesPath: null,
	authority: { tools: ['web_fetch'], connectors: [], read: ['/library/notes/**'], write: ['/library/reports/**'] },
	gates: ['publishing'],
	escalation: 'Stop when unsure.',
	forbidden: ['Bash(rm *)'],
	budget: { perRunUsd: 2, perDayUsd: null },
	trigger: { kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } },
	report: 'digest',
	worker: null,
	deliverables: [{ path: '/library/reports/{slug}/{date}.md', kind: 'markdown', requiredSections: ['Summary', 'Findings'], minChars: 200 }],
	notes: [],
	status: 'active',
	createdBy: 'client',
	createdAt: 0,
	updatedAt: 0,
	version: 1,
	triggerState: { status: 'active', pausedReason: null, nextFireAt: 1, lastFireAt: null, lastStatus: null, failures: 0 }
};

describe('program form', () => {
	test('lines: trimmed, no blanks, no duplicates', () => {
		expect(splitLines(' a \n\nb\na\n  ')).toEqual(['a', 'b']);
		expect(splitLines('')).toEqual([]);
	});

	test('usd: empty is no limit, positive numbers pass, the rest is invalid', () => {
		expect(parseUsd('')).toBeNull();
		expect(parseUsd(' 2.5 ')).toBe(2.5);
		expect(parseUsd('0')).toBe('invalid');
		expect(parseUsd('-1')).toBe('invalid');
		expect(parseUsd('abc')).toBe('invalid');
	});

	test('a program round-trips through the form and back to the API body', () => {
		const form = formFromProgram(program, 'UTC');
		expect(form).toMatchObject({ tools: 'web_fetch', read: '/library/notes/**', perRunUsd: '2', perDayUsd: '', triggerKind: 'schedule', report: 'digest' });
		expect(form.schedule).toMatchObject({ kind: 'weekdays', time: '09:00' });
		const body = bodyFromForm(form);
		expect(body.authority).toEqual(program.authority);
		expect(body.gates).toEqual(['publishing']);
		expect(body.forbidden).toEqual(['Bash(rm *)']);
		expect(body.budget).toEqual({ perRunUsd: 2, perDayUsd: null, maxOutputTokens: null });
		expect(body.trigger).toEqual({ kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } });
		expect(body.deliverables).toEqual(program.deliverables);
	});

	test('deliverables: rows round-trip, schema text is parsed, problems are found per row', () => {
		const rows = formFromProgram(program, 'UTC').deliverables;
		expect(rows[0]).toMatchObject({ kind: 'markdown', sections: 'Summary\nFindings', minChars: '200' });
		const json = { ...emptyDeliverableRow(), path: '/library/data-{date}.json', kind: 'json' as const, schema: '{ "type": "object" }' };
		expect(deliverableFromRow(json)).toEqual({ path: '/library/data-{date}.json', kind: 'json', schema: { type: 'object' } });
		// headings do not belong to a json row
		expect(deliverableFromRow({ ...json, sections: 'A' })).not.toHaveProperty('requiredSections');
		expect(validateDeliverables([json, ...rows])).toEqual({});
		expect(validateDeliverables([emptyDeliverableRow()])['deliverables.0']).toContain('path');
		expect(validateDeliverables([{ ...json, path: 'library/x' }])['deliverables.0']).toContain('starting with /');
		expect(validateDeliverables([{ ...json, path: '/library/{when}.json' }])['deliverables.0']).toContain('Unknown token {when}');
		expect(validateDeliverables([{ ...json, schema: '[1]' }])['deliverables.0']).toContain('JSON object');
		expect(validateDeliverables([{ ...json, minChars: '0' }])['deliverables.0']).toContain('whole number');
		// the form blocks saving a bad row
		expect(Object.keys(validateProgramForm({ ...emptyProgramForm(), name: 'n', brief: 'b', deliverables: [emptyDeliverableRow()] }))).toEqual(['deliverables.0']);
	});

	test('a manual program sends a manual trigger', () => {
		const body = bodyFromForm({ ...emptyProgramForm(), name: 'x', brief: 'y' });
		expect(body.trigger).toEqual({ kind: 'manual' });
		expect(body.budget).toEqual({ perRunUsd: null, perDayUsd: null, maxOutputTokens: null });
	});

	test('a worker program: the queue option round-trips and is validated', () => {
		const worker = { ...program, worker: { maxTasks: 5 } };
		const form = formFromProgram(worker, 'UTC');
		expect(form).toMatchObject({ worker: true, maxTasks: '5' });
		expect(bodyFromForm(form).worker).toEqual({ maxTasks: 5 });
		expect(bodyFromForm(formFromProgram(program, 'UTC')).worker).toBeNull();
		const bad = { ...emptyProgramForm(), name: 'n', brief: 'b', worker: true, maxTasks: '0' };
		expect(Object.keys(validateProgramForm(bad))).toEqual(['maxTasks']);
		expect(validateProgramForm({ ...bad, maxTasks: '4' })).toEqual({});
		expect(validateProgramForm({ ...bad, worker: false, maxTasks: 'x' })).toEqual({});
	});

	test('validation: name, brief, path globs and budgets', () => {
		expect(Object.keys(validateProgramForm(emptyProgramForm()))).toEqual(['name', 'brief']);
		const f = { ...emptyProgramForm(), name: 'n', brief: 'b', read: 'library/x', write: '/library/../x', perRunUsd: '0' };
		expect(Object.keys(validateProgramForm(f)).sort()).toEqual(['perRunUsd', 'read', 'write']);
		expect(validateProgramForm({ ...emptyProgramForm(), name: 'n', brief: 'b', write: '/library/out/**' })).toEqual({});
	});

	test('badges follow the program, then its schedule trigger', () => {
		expect(programBadge(program)).toEqual({ label: 'active', variant: 'success' });
		expect(programBadge({ ...program, status: 'paused' }).label).toBe('paused');
		const failing = { ...program, triggerState: { ...program.triggerState!, failures: 2 } };
		expect(programBadge(failing)).toEqual({ label: 'active, 2 failed', variant: 'warning' });
		const stopped = { ...program, triggerState: { ...program.triggerState!, status: 'paused' as const, pausedReason: 'max-failures' as const } };
		expect(programBadge(stopped)).toEqual({ label: 'paused: too many failures', variant: 'destructive' });
		expect(programBadge({ ...program, triggerState: null }).label).toBe('active');
	});

	test('summaries', () => {
		expect(authoritySummary(program.authority)).toBe('1 tool, read 1, write 1');
		expect(authoritySummary({ tools: [], connectors: [], read: [], write: [] })).toBe('nothing granted');
		expect(budgetSummary({ perRunUsd: 2, perDayUsd: 10 })).toBe('$2 / run, $10 / day');
		expect(budgetSummary({ perRunUsd: 0.5, perDayUsd: null })).toBe('$0.50 / run');
		expect(budgetSummary({ perRunUsd: 0.001, perDayUsd: 0.0085 })).toBe('$0.001 / run, $0.0085 / day');
		expect(budgetSummary({ perRunUsd: null, perDayUsd: null })).toBe('no limit');
	});

	test('the output cap: empty is sized from the budget, otherwise 256 to 65536, and it round-trips', () => {
		expect(parseOutputCap('')).toBeNull();
		expect(parseOutputCap(' 4096 ')).toBe(4096);
		expect(parseOutputCap('100')).toBe('invalid');
		expect(parseOutputCap('70000')).toBe('invalid');
		expect(parseOutputCap('1.5')).toBe('invalid');
		const form = { ...formFromProgram({ ...program, budget: { perRunUsd: 0.05, perDayUsd: null, maxOutputTokens: 4096 } }, 'UTC') };
		expect(form.maxOutputTokens).toBe('4096');
		expect(bodyFromForm(form).budget).toEqual({ perRunUsd: 0.05, perDayUsd: null, maxOutputTokens: 4096 });
		expect(validateProgramForm({ ...form, maxOutputTokens: '10' }).maxOutputTokens).toBeTruthy();
	});

	test('the check request is the agent, the authority and the budget as typed; warnings are picked by field', () => {
		const form = formFromProgram(program, 'UTC');
		expect(checkFromForm(form, '')).toBeUndefined();
		expect(checkFromForm(form, 'a1')).toEqual({ agentId: 'a1', brief: program.brief, authority: program.authority, budget: { perRunUsd: 2, perDayUsd: null, maxOutputTokens: null } });
		const warnings = [
			{ code: 'tool-unavailable' as const, field: 'authority.tools', message: 'write_file: no such tool' },
			{ code: 'budget-below-minimum' as const, field: 'budget.perRunUsd', message: 'too small' }
		];
		expect(warningsOf(warnings, 'authority.tools').map((w) => w.code)).toEqual(['tool-unavailable']);
		expect(warningsOf(warnings, 'budget.perRunUsd', 'budget.perDayUsd').map((w) => w.code)).toEqual(['budget-below-minimum']);
	});
});

describe('lastStatusText', () => {
	test('a slot skipped by Pause all reads as workspace paused, other statuses are unchanged', () => {
		expect(lastStatusText('skipped: paused')).toBe('skipped: workspace paused');
		expect(lastStatusText('needs_action')).toBe('needs action');
		expect(lastStatusText('succeeded')).toBe('succeeded');
	});
});
