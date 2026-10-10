import { describe, expect, test } from 'bun:test';
import { groupSummary, isActivityTool, reasoningLabel, type ToolView } from './activity';

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
		expect(s).toEqual({ label: 'Used 3 tools', names: 'Update todos, Read agent output ×2', running: false, failed: 1 });
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
