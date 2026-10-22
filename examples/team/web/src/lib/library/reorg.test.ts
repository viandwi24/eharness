import { describe, expect, test } from 'bun:test';
import { destinationText, errorsOf, resultText, rowsOf, setAction, setTarget, type ReorgPlan } from './reorg';

const plan = {
	rows: [
		{ source: 'a.md', action: 'move', target: '/library/knowledge/a.md', reason: 'x', finalTarget: '/library/knowledge/a-2.md', originalPath: '/o/a.md' },
		{ source: 'b.md', action: 'keep-as-rule', target: null, reason: 'y', finalTarget: 'memory:rules.md', originalPath: '/o/b.md' }
	],
	issues: [
		{ source: 'a.md', level: 'note', message: 'suffix' },
		{ source: 'b.md', level: 'error', message: 'bad' }
	]
} as unknown as ReorgPlan;

describe('reorganization rows', () => {
	test('rows are the editable part of the plan', () => {
		expect(rowsOf(plan)[0]).toEqual({ source: 'a.md', action: 'move', target: '/library/knowledge/a.md', reason: 'x' });
	});

	test('changing the action sets a sensible target', () => {
		const rows = rowsOf(plan);
		expect(setAction(rows, 'b.md', 'move')[1]?.target).toBe('/library/knowledge/b.md');
		expect(setAction(rows, 'a.md', 'archive')[0]?.target).toBeNull();
		expect(setAction(rows, 'a.md', 'merge-into')[0]?.target).toBeNull();
		expect(setAction(rows, 'a.md', 'move')[0]?.target).toBe('/library/knowledge/a.md');
		expect(setTarget(rows, 'a.md', ' /library/company/a.md ')[0]?.target).toBe('/library/company/a.md');
		expect(setTarget(rows, 'a.md', '  ')[0]?.target).toBeNull();
	});

	test('errors, destinations and the result line', () => {
		expect(errorsOf(plan).map((i) => i.source)).toEqual(['b.md']);
		expect(errorsOf(plan, 'a.md')).toEqual([]);
		expect(destinationText(plan.rows[1]!)).toBe('rules.md');
		expect(destinationText(plan.rows[0]!)).toBe('/library/knowledge/a-2.md');
		expect(resultText({ counts: { added: 3, changed: 2, removed: 5, failed: 1 } })).toBe(
			'3 library files written, 5 originals moved to the archive, 2 rewritten, 1 failed (those files stay in memory).'
		);
	});
});
