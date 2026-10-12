import { describe, expect, test } from 'bun:test';
import { groupSummary, isActivityTool, reasoningLabel, type ToolView, writtenFiles } from './activity';

const t = (title: string, state: ToolView['state'] = 'output-available', extra: Partial<ToolView> = {}): ToolView => ({
	kind: 'tool',
	key: `${title}-${Math.random()}`,
	toolCallId: 'c',
	toolName: 'x',
	title,
	state,
	input: {},
	isSubagent: false,
	...extra
});

describe('activity rows', () => {
	test('subagent cards and approval requests stay out of tool groups', () => {
		expect(isActivityTool(t('Read'))).toBe(true);
		expect(isActivityTool(t('Agent', 'output-available', { isSubagent: true }))).toBe(false);
		expect(isActivityTool(t('Write', 'approval-requested'))).toBe(false);
	});

	test('group summary counts tools and repeats', () => {
		const s = groupSummary([t('Update todos'), t('Read agent output'), t('Read agent output', 'output-error')]);
		expect(s).toEqual({ label: 'Used 3 tools', names: 'Update todos, Read agent output ×2', running: false, failed: 1, declined: 0 });
	});

	test('declined calls are counted', () => {
		expect(groupSummary([t('A', 'output-denied'), t('B', 'output-denied'), t('C')]).declined).toBe(2);
	});

	test('a running tool names the group', () => {
		const s = groupSummary([t('Update todos'), t('Search the web', 'input-available')]);
		expect(s.label).toBe('Running Search the web…');
		expect(s.running).toBe(true);
	});

	test('reasoning labels', () => {
		expect(reasoningLabel(true)).toBe('Thinking…');
		expect(reasoningLabel(false, 900)).toBe('Thought for 1 second');
		expect(reasoningLabel(false, 3200)).toBe('Thought for 3 seconds');
		expect(reasoningLabel(false)).toBe('Thought for a few seconds');
	});
});

describe('written files', () => {
	const w = (toolName: string, path: string, state: ToolView['state'] = 'output-available', output: unknown = 'ok') =>
		t(`x ${path}`, state, { toolName, input: { path }, output });
	test('one card per written path; failures and internal folders are left out', () => {
		expect(
			writtenFiles([
				w('write_file', '/library/a.md'),
				w('edit_file', '/library/a.md'),
				w('edit_file', '/library/b.ts'),
				w('write_file', '/library/c.md', 'output-error'),
				w('write_file', '/library/d.md', 'output-available', 'Error: stale file'),
				w('write_file', '/memories/workspace/x.md'),
				w('read_file', '/library/e.md')
			])
		).toEqual([
			{ path: '/library/a.md', action: 'created' },
			{ path: '/library/b.ts', action: 'edited' }
		]);
	});
});
