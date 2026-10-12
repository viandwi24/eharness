import { describe, expect, test } from 'bun:test';
import { grantLines, kindSummary, type EffectiveGrant } from './grant.js';

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
