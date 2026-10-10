/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { hasVisibleParts, messageKind, toolTitle, viewModel } from './map.ts';

const msg = (parts: unknown[], extra: Partial<UIMessage> = {}): UIMessage =>
	({ id: 'm1', role: 'assistant', parts, ...extra }) as UIMessage;

describe('viewModel', () => {
	test('text and reasoning with duration', () => {
		const v = viewModel(
			msg([
				{ type: 'reasoning', text: 'hmm', state: 'done', providerMetadata: { eharness: { durationMs: 2300 } } },
				{ type: 'reasoning', text: '...', state: 'streaming' },
				{ type: 'text', text: 'hi', state: 'streaming' },
				{ type: 'text', text: 'done', state: 'done' },
				{ type: 'step-start' }
			])
		);
		expect(v.map((x) => x.kind)).toEqual(['reasoning', 'reasoning', 'text', 'text']);
		expect(v[0]).toMatchObject({ durationMs: 2300, streaming: false });
		expect(v[1]).toMatchObject({ streaming: true });
		expect(v[2]).toMatchObject({ streaming: true });
	});

	test.each([
		['input-streaming'],
		['input-available'],
		['output-available'],
		['output-error'],
		['approval-responded']
	] as const)('tool state %s', (state: string) => {
		const v = viewModel(
			msg([{ type: 'tool-read_file', toolCallId: 'c1', state, input: { path: '/a.md' }, output: 'x', errorText: 'boom' }])
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ kind: 'tool', toolName: 'read_file', title: 'Read /a.md', state, isSubagent: false });
	});

	test('approval requested emits tool + approval views', () => {
		const v = viewModel(
			msg([{ type: 'tool-bash', toolCallId: 'c1', state: 'approval-requested', input: { command: 'ls -la' }, approval: { id: 'a1' } }])
		);
		expect(v.map((x) => x.kind)).toEqual(['tool', 'approval']);
		expect(v[1]).toMatchObject({ kind: 'approval', approval: { id: 'a1' }, title: 'Run ls -la' });
	});

	test('denied tool surfaces the reason', () => {
		const v = viewModel(
			msg([{ type: 'dynamic-tool', toolName: 'mcp_x', toolCallId: 'c1', state: 'output-denied', input: {}, approval: { id: 'a1', approved: false, reason: 'no' } }])
		);
		expect(v[0]).toMatchObject({ kind: 'tool', toolName: 'mcp_x', state: 'output-denied', errorText: 'no' });
		expect(v[1]).toMatchObject({ kind: 'approval', state: 'output-denied' });
	});

	test('agent tool: progress and run merge', () => {
		const progress = { status: 'running', agent: 'researcher', steps: 2, lastTool: 'web_search', text: 'found' };
		const v = viewModel(
			msg([
				{ type: 'tool-agent', toolCallId: 'c1', state: 'input-available', input: { subagent_type: 'researcher' }, output: progress, preliminary: true },
				{ type: 'data-subagent.run', id: 'c1', data: { toolCallId: 'c1', sessionId: 's:agent:c1', agent: 'researcher', status: 'running' } }
			])
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ kind: 'tool', isSubagent: true, progress, preliminary: true, output: undefined });
		expect((v[0] as { run?: { sessionId: string } }).run?.sessionId).toBe('s:agent:c1');
	});

	test('orphan data-subagent.run becomes a subagentRun view', () => {
		const v = viewModel(msg([{ type: 'data-subagent.run', data: { toolCallId: 'c9', sessionId: 's', agent: 'writer', status: 'waiting', name: 'w' } }]));
		expect(v[0]).toMatchObject({ kind: 'subagentRun', run: { status: 'waiting', name: 'w' } });
	});

	test('data-eh.input, file, sources, unknown', () => {
		const v = viewModel(
			msg([
				{ type: 'data-eh.input', data: { source: 'user', text: 'also check X', files: [{ type: 'file', url: 'u', mediaType: 'image/png' }] } },
				{ type: 'data-eh.input', data: { source: 'plugin:hooks', text: 'ctx' } },
				{ type: 'file', url: 'https://x/a.pdf', mediaType: 'application/pdf', filename: 'a.pdf' },
				{ type: 'source-url', sourceId: 's', url: 'https://x.dev/p', title: 'X' },
				{ type: 'data-todos.list', data: {} }
			])
		);
		expect(v.map((x) => x.kind)).toEqual(['input', 'input', 'file', 'source', 'unknown']);
		expect(v[0]).toMatchObject({ source: 'user', files: [{ url: 'u' }] });
		expect(v[1]).toMatchObject({ source: 'plugin:hooks' });
	});

	test('kind messages', () => {
		const ev = msg([{ type: 'data-eh.event', data: { name: 'subagent.report', text: 'report body' } }], {
			role: 'user',
			metadata: { eharness: { v: 1, kind: 'eh.event' } }
		} as never);
		expect(messageKind(ev)).toBe('eh.event');
		expect(viewModel(ev)[0]).toMatchObject({ kind: 'event', name: 'subagent.report' });
		const co = msg([{ type: 'data-eh.compaction', data: { summary: 's', tokens: { before: 1 }, trigger: 'auto' } }], {
			role: 'user',
			metadata: { eharness: { kind: 'eh.compaction' } }
		} as never);
		expect(viewModel(co)[0]).toMatchObject({ kind: 'compaction', summary: 's', trigger: 'auto' });
	});
});

test('toolTitle fallbacks', () => {
	expect(toolTitle('tool_search')).toBe('Loaded tools');
	expect(toolTitle('web_fetch', { url: 'https://a.b' })).toBe('Fetch https://a.b');
	expect(toolTitle('custom_tool')).toBe('custom_tool');
	expect(toolTitle('read_file', null)).toBe('Read');
});

test('hasVisibleParts', () => {
	expect(hasVisibleParts(viewModel(msg([{ type: 'text', text: '', state: 'streaming' }])))).toBe(false);
	expect(hasVisibleParts(viewModel(msg([{ type: 'text', text: 'a' }])))).toBe(true);
});
