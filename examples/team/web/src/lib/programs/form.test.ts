import { describe, expect, test } from 'bun:test';
import {
	authoritySummary,
	bodyFromForm,
	budgetSummary,
	emptyProgramForm,
	formFromProgram,
	parseUsd,
	programBadge,
	splitLines,
	validateProgramForm,
	type Program
} from './form';

const program: Program = {
	id: 'p1',
	agentId: 'a1',
	name: 'Video scripts',
	brief: 'Write a script for every new title.',
	authority: { tools: ['web_fetch'], connectors: [], read: ['/library/videos/**'], write: ['/library/reports/**'] },
	gates: ['publishing'],
	escalation: 'Stop when unsure.',
	forbidden: ['Bash(rm *)'],
	budget: { perRunUsd: 2, perDayUsd: null },
	trigger: { kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } },
	report: 'digest',
	worker: null,
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
		expect(form).toMatchObject({ tools: 'web_fetch', read: '/library/videos/**', perRunUsd: '2', perDayUsd: '', triggerKind: 'schedule', report: 'digest' });
		expect(form.schedule).toMatchObject({ kind: 'weekdays', time: '09:00' });
		const body = bodyFromForm(form);
		expect(body.authority).toEqual(program.authority);
		expect(body.gates).toEqual(['publishing']);
		expect(body.forbidden).toEqual(['Bash(rm *)']);
		expect(body.budget).toEqual({ perRunUsd: 2, perDayUsd: null });
		expect(body.trigger).toEqual({ kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } });
	});

	test('a manual program sends a manual trigger', () => {
		const body = bodyFromForm({ ...emptyProgramForm(), name: 'x', brief: 'y' });
		expect(body.trigger).toEqual({ kind: 'manual' });
		expect(body.budget).toEqual({ perRunUsd: null, perDayUsd: null });
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
		expect(budgetSummary({ perRunUsd: null, perDayUsd: null })).toBe('no limit');
	});
});
