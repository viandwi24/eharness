import { describe, expect, test } from 'bun:test';
import type { Approval } from '../api/client.js';
import { entryKey, groupPending } from './group.js';

const a = (id: string, toolName: string, over: Partial<Approval> = {}): Approval =>
	({ id, kind: 'approval', sessionId: 's1', parentSessionId: null, agentId: 'x', agentName: 'Researcher', taskId: null, toolCallId: id, toolName, risk: null, questions: null, answeredWaiting: 0, ...over }) as Approval;
const q = (id: string): Approval => a(id, 'ask_user_question', { kind: 'question' });

describe('groupPending', () => {
	test('parallel approvals of one tool become one group at the first member', () => {
		const e = groupPending([a('1', 'web_search'), q('q'), a('2', 'web_search'), a('3', 'web_search')]);
		expect(e.map((x) => x.kind)).toEqual(['group', 'single']);
		expect(e[0]).toMatchObject({ kind: 'group', toolName: 'web_search' });
		expect((e[0] as { items: Approval[] }).items.map((i) => i.id)).toEqual(['1', '2', '3']);
	});

	test('different tools, a lone approval, questions and other sessions stay single', () => {
		const e = groupPending([a('1', 'web_search'), a('2', 'web_fetch'), a('3', 'web_search', { sessionId: 's2' }), q('q1'), q('q2')]);
		expect(e.every((x) => x.kind === 'single')).toBe(true);
		expect(e).toHaveLength(5);
	});

	test('the key changes with the members', () => {
		const [g1] = groupPending([a('1', 't'), a('2', 't')]);
		const [g2] = groupPending([a('1', 't'), a('2', 't'), a('3', 't')]);
		expect(entryKey(g1!)).not.toBe(entryKey(g2!));
	});
});
