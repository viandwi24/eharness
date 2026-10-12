import { describe, expect, test } from 'bun:test';
import { grantLines, kindSummary, problemNames, uniqueWarnings, type EffectiveGrant } from './grant.js';

const grant: EffectiveGrant = {
	connectors: [
		{
			requested: 'mcp-remote',
			id: 'mcp-remote',
			label: 'tracker-demo',
			tools: [
				{ name: 'list_tasks', kind: 'read', status: 'granted' },
				{ name: 'get_task', kind: 'read', status: 'granted' },
				{ name: 'update_task', kind: 'write', status: 'gate' }
			]
		},
		{ requested: 'tracker-x', id: null, label: 'tracker-x', tools: [] }
	],
	tools: [{ name: 'nope', kind: 'unknown', status: 'unavailable' }],
	read: [],
	write: []
};

describe('grantLines', () => {
	test('a connector shows its resolved tools; gates and phantoms are called out', () => {
		const lines = grantLines(grant);
		expect(lines[0]).toMatchObject({ text: 'tracker-demo: 2 read', tone: 'ok' });
		expect(lines[0]!.detail).toContain('update_task still ask you');
		expect(lines[1]).toMatchObject({ tone: 'bad' });
		expect(lines[2]).toMatchObject({ text: 'nope', tone: 'bad' });
	});
	test('no grant, no lines', () => {
		expect(grantLines(null)).toEqual([]);
		expect(kindSummary([])).toBe('');
	});
});

describe('showing a problem once', () => {
	const warnings = [{ message: 'list_projects: the agent has no such tool (its connector is off or the name is wrong).' }, { message: 'other_tool: its connector mode is Off.' }];
	const errors = ['authority.tools: the agent has no tool "list_projects". Did you mean: tracker-demo_list_projects?'];

	test('a warning an error already says is dropped', () => {
		expect(uniqueWarnings(warnings, errors).map((w) => w.message.split(':')[0])).toEqual(['other_tool']);
	});
	test('names with a problem elsewhere are skipped in the grant lines', () => {
		const { all } = problemNames(warnings, errors);
		expect(all.has('list_projects') && all.has('other_tool')).toBe(true);
		const texts = grantLines({ ...grant, tools: [{ name: 'list_projects', kind: 'unknown', status: 'unavailable' }, { name: 'web_fetch', kind: 'read', status: 'granted' }] }, all).map((l) => l.text);
		expect(texts).toContain('web_fetch');
		expect(texts).not.toContain('list_projects');
	});
});
