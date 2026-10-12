import { describe, expect, test } from 'bun:test';
import { bodyFromTaskForm, clearFixedErrors, dueFromInput, dueLabel, dueToInput, emptyTaskForm, queueStatus, validateTaskForm } from './queue';

describe('task form', () => {
	test('validation', () => {
		expect(Object.keys(validateTaskForm(emptyTaskForm()))).toEqual(['agentId', 'title']);
		const ok = { ...emptyTaskForm('a1'), title: 'Weekly summary: March', inputs: '/library/notes/inputs.md\n\n/library/x', due: '2026-11-01' };
		expect(validateTaskForm(ok)).toEqual({});
		expect(validateTaskForm({ ...ok, inputs: 'notes.md' }).inputs).toContain('notes.md');
		expect(validateTaskForm({ ...ok, inputs: '/library/../x' }).inputs).toBeDefined();
		expect(validateTaskForm({ ...ok, due: 'tomorrow' }).due).toBeDefined();
	});

	test('an error clears when its field becomes valid; server errors stay', () => {
		const errs = { agentId: 'Choose who does the task.', title: 'Give the task a title.', brief: 'server says no' };
		expect(Object.keys(clearFixedErrors(errs, { ...emptyTaskForm('a1'), title: '' }))).toEqual(['title', 'brief']);
		expect(Object.keys(clearFixedErrors(errs, { ...emptyTaskForm('a1'), title: 'x' }))).toEqual(['brief']);
	});

	test('the API body: trimmed, inputs split, due as the end of the day', () => {
		const body = bodyFromTaskForm({
			agentId: 'a1',
			title: '  Research: tides ',
			brief: '  ## Goal ',
			inputs: '/library/a\n/library/a\n/library/b',
			priority: 'high',
			due: '2026-11-15',
			hold: false,
			review: true,
			grantTools: '',
			grantRead: '',
			grantWrite: ''
		});
		expect(body).toEqual({
			agentId: 'a1',
			title: 'Research: tides',
			brief: '## Goal',
			inputs: ['/library/a', '/library/b'],
			priority: 'high',
			dueAt: Date.parse('2026-11-15T23:59:59Z')
		});
		expect(bodyFromTaskForm({ ...emptyTaskForm('a1'), title: 't' })).toEqual({ agentId: 'a1', title: 't', inputs: [], priority: 'normal', dueAt: null });
	});

	test('due dates', () => {
		expect(dueFromInput('')).toBeNull();
		expect(dueToInput(dueFromInput('2026-11-15'))).toBe('2026-11-15');
		expect(dueToInput(null)).toBe('');
		const late = dueLabel(Date.parse('2026-01-02T00:00:00Z'), Date.parse('2026-02-01T00:00:00Z'));
		expect(late).toEqual({ text: 'due Jan 2', late: true });
		expect(dueLabel(null)).toBeNull();
	});
});

describe('assigning work', () => {
	test('defaults start on their own and go to Review; only changes are sent', () => {
		const base = { ...emptyTaskForm('a1'), title: 't' };
		expect(bodyFromTaskForm(base)).not.toHaveProperty('hold');
		expect(bodyFromTaskForm(base)).not.toHaveProperty('review');
		expect(bodyFromTaskForm(base)).not.toHaveProperty('grants');
		expect(bodyFromTaskForm({ ...base, hold: true, review: false })).toMatchObject({ hold: true, review: false });
	});

	test('grants are split by line and their paths are checked', () => {
		const f = { ...emptyTaskForm('a1'), title: 't', grantTools: 'add_comment\nupdate_task', grantRead: '/library/**', grantWrite: '/library/reports/**' };
		expect(bodyFromTaskForm(f).grants).toEqual({ tools: ['add_comment', 'update_task'], read: ['/library/**'], write: ['/library/reports/**'] });
		expect(validateTaskForm({ ...f, grantWrite: 'reports' }).grantWrite).toContain('reports');
		expect(validateTaskForm(f)).toEqual({});
	});

	test('why a queued task waits', () => {
		expect(queueStatus({ status: 'running' })).toBeNull();
		expect(queueStatus({ status: 'queued', hold: true })?.label).toBe('on hold');
		expect(queueStatus({ status: 'queued', queue: 'worker' })?.label).toBe('waits for worker');
		expect(queueStatus({ status: 'queued', queue: 'slot' })?.label).toBe('waiting for a slot');
		expect(queueStatus({ status: 'queued', queue: 'starting' })?.label).toBe('starting');
		expect(queueStatus({ status: 'queued' })?.label).toBe('queued');
	});
});
