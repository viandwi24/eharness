import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { chatOutputs, formatBadge, hostOf, latestTodoList, markdownTitle, todoPercent, toolViews, usedSummary } from './derive';

const msg = (parts: unknown[], id = 'm1'): UIMessage => ({ id, role: 'assistant', parts }) as unknown as UIMessage;
const tool = (name: string, input: unknown, output: unknown = 'ok') => ({
	type: `tool-${name}`,
	toolCallId: `${name}-${Math.random()}`,
	state: 'output-available',
	input,
	output
});

describe('session derive', () => {
	test('latest todo list and percent', () => {
		const a = msg([{ type: 'data-todos.list', data: { todos: [{ content: 'a', status: 'pending' }] } }], 'a');
		const b = msg(
			[{ type: 'data-todos.list', data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'cancelled' }] } }],
			'b'
		);
		const list = latestTodoList([a, b]);
		expect(list.map((t) => t.status)).toEqual(['completed', 'in_progress', 'cancelled']);
		expect(todoPercent(list)).toBe(50);
		expect(latestTodoList([])).toEqual([]);
		expect(todoPercent([])).toBe(0);
	});

	test('outputs are the written files, newest first', () => {
		const views = toolViews([msg([tool('write_file', { path: '/library/a.md' }), tool('write_file', { path: '/library/b.pdf' })])]);
		expect(chatOutputs(views)).toEqual(['/library/b.pdf', '/library/a.md']);
	});

	test('used summary groups web, files, memory and tools', () => {
		const u = usedSummary([
			msg([
				{ type: 'source-url', sourceId: 's', url: 'https://www.example.com/x', title: 'x' },
				tool('web_fetch', { url: 'https://docs.dev/a' }),
				tool('read_file', { path: '/library/notes.md' }),
				tool('memory_read', { path: '/memories/career.md' }),
				tool('memory_write', { path: '/memories/tech.md' }),
				tool('calendar_list', {}),
				tool('todo_write', {})
			])
		]);
		expect(u.web.hosts).toEqual(['example.com', 'docs.dev']);
		expect(u.filesRead).toEqual({ names: ['notes.md'], count: 1 });
		expect(u.memory).toEqual({ read: ['career'], write: ['tech'], calls: 2 });
		expect(u.tools).toEqual({ names: ['calendar list'], calls: 1 });
	});

	test('small helpers', () => {
		expect(markdownTitle('intro\n# Hello *world*\n')).toBe('Hello world');
		expect(markdownTitle('no heading')).toBeUndefined();
		expect(formatBadge('/a/b.md')).toBe('MD');
		expect(formatBadge('/a/Makefile')).toBe('FILE');
		expect(hostOf('not a url')).toBeNull();
	});
});
