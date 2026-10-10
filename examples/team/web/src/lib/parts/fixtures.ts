// Mock UIMessages exercising every part kind. Used by ChatPane until the live chat (`$lib/chat`) is wired.
import type { UIMessage } from 'ai';

const m = (id: string, role: UIMessage['role'], parts: unknown[], metadata?: unknown): UIMessage =>
	({ id, role, parts, metadata }) as UIMessage;

export type FixtureMessage = { message: UIMessage; agentId?: string };

export const fixtureMessages: FixtureMessage[] = [
	{ message: m('f1', 'user', [{ type: 'text', text: 'Can you scan our top three competitors and summarise pricing changes?' }]) },
	{
		agentId: 'lead',
		message: m('f2', 'assistant', [
			{ type: 'reasoning', state: 'done', text: 'Split the work: research first, then a one page summary.', providerMetadata: { eharness: { durationMs: 3200 } } },
			{ type: 'text', state: 'done', text: 'On it. I asked **Researcher** to collect pricing pages and **Writer** to prepare a summary.' },
			{ type: 'tool-tool_search', toolCallId: 't0', state: 'output-available', input: { query: 'agents' }, output: 'agent, send_message' },
			{
				type: 'tool-agent',
				toolCallId: 't1',
				state: 'input-available',
				input: { subagent_type: 'researcher', description: 'Collect competitor pricing pages', prompt: '...' },
				output: { status: 'running', agent: 'researcher', description: 'Collect competitor pricing pages', sessionId: 'lead:agent:t1', steps: 3, lastTool: 'web_fetch', text: 'Fetched 2 of 3 pricing pages' },
				preliminary: true
			},
			{ type: 'data-subagent.run', id: 't1', data: { toolCallId: 't1', sessionId: 'lead:agent:t1', agent: 'researcher', status: 'running' } },
			{ type: 'data-eh.input', data: { source: 'user', text: 'Also include annual-plan discounts.' } }
		])
	},
	{
		agentId: 'researcher',
		message: m('f3', 'assistant', [
			{ type: 'tool-web_fetch', toolCallId: 't2', state: 'output-available', input: { url: 'https://example.com/pricing' }, output: 'Pro: $20/mo' },
			{ type: 'tool-write_file', toolCallId: 't3', state: 'approval-requested', input: { path: '/research/notes.md', content: '# Notes' }, approval: { id: 'ap1' } },
			{ type: 'tool-bash', toolCallId: 't4', state: 'output-error', input: { command: 'curl example.invalid' }, errorText: 'Could not resolve host' },
			{ type: 'source-url', sourceId: 's1', url: 'https://example.com/pricing', title: 'Example pricing' }
		])
	},
	{
		message: m(
			'f4',
			'user',
			[{ type: 'data-eh.event', data: { name: 'subagent.report', text: Array.from({ length: 12 }, (_, i) => `- finding ${i + 1}`).join('\n') } }],
			{ eharness: { v: 1, kind: 'eh.event' } }
		)
	},
	{
		message: m('f5', 'user', [{ type: 'data-eh.compaction', data: { summary: 'Earlier: competitor scan scoped.', trigger: 'auto' } }], {
			eharness: { v: 1, kind: 'eh.compaction' }
		})
	}
];
