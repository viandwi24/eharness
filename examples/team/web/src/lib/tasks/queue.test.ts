import { describe, expect, test } from 'bun:test';
import { bodyFromTaskForm, dueFromInput, dueLabel, dueToInput, emptyTaskForm, validateTaskForm } from './queue';

describe('task form', () => {
	test('validation', () => {
		expect(Object.keys(validateTaskForm(emptyTaskForm()))).toEqual(['agentId', 'title']);
		const ok = { ...emptyTaskForm('a1'), title: 'Script: the island', inputs: '/library/production/videos.md\n\n/library/x', due: '2026-11-01' };
		expect(validateTaskForm(ok)).toEqual({});
		expect(validateTaskForm({ ...ok, inputs: 'videos.md' }).inputs).toContain('videos.md');
		expect(validateTaskForm({ ...ok, inputs: '/library/../x' }).inputs).toBeDefined();
		expect(validateTaskForm({ ...ok, due: 'tomorrow' }).due).toBeDefined();
	});

	test('the API body: trimmed, inputs split, due as the end of the day', () => {
		const body = bodyFromTaskForm({
			agentId: 'a1',
			title: '  Research: tides ',
			brief: '  ## Goal ',
			inputs: '/library/a\n/library/a\n/library/b',
			priority: 'high',
			due: '2026-11-15'
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
