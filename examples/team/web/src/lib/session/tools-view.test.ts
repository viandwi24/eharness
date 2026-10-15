import { describe, expect, test } from 'bun:test';
import { groupSessionTools, type SessionTools } from './tools-view';

const group = (name: string, label: string, tools: Array<[string, 'allow' | 'ask' | 'off', boolean?]>) => ({
	connectionId: `c-${name}`,
	connectorId: name.toLowerCase(),
	name,
	label,
	tools: tools.map(([n, mode, chatOff]) => ({ name: n, mode, chatOff: chatOff ?? false }))
});

const base = (over: Partial<SessionTools>): SessionTools => ({
	sessionId: 'dm:a',
	agentId: 'a',
	configured: [],
	lastCall: null,
	lastCallNote: null,
	missing: [],
	extra: [],
	...over
});

describe('groupSessionTools', () => {
	test('badges per tool and counts per connector', () => {
		const view = groupSessionTools(
			base({
				configured: [
					group('Phone', 'phone', [['phone__tap', 'allow'], ['phone__swipe', 'allow'], ['phone__shot', 'ask'], ['phone__lock', 'off'], ['phone__home', 'allow', true]]),
					group('Files', 'Files', [['read_file', 'allow']])
				],
				lastCall: { id: 'c1', at: 1, loaded: ['read_file', 'phone__tap', 'tool_search'], deferred: ['phone__swipe'] },
				missing: ['phone__shot'],
				extra: ['tool_search']
			})
		);
		expect(view.checked).toBe(true);
		expect(view.missing).toEqual(['phone__shot']);
		// the group with a missing tool comes first
		expect(view.groups.map((g) => g.title)).toEqual(['Phone', 'Files']);
		const phone = view.groups[0]!;
		expect(phone.summary).toBe('Phone — 2 of 3 available');
		expect(phone.rows.map((r) => [r.name, r.state])).toEqual([
			['phone__shot', 'missing'],
			['phone__tap', 'loaded'],
			['phone__swipe', 'deferred'],
			['phone__home', 'chat-off'],
			['phone__lock', 'off']
		]);
		expect(phone.rows[0]!.asks).toBe(true);
		expect(view.groups[1]!.summary).toBe('Files — 1 of 1 available');
	});

	test('without a readable last call nothing is flagged missing', () => {
		const view = groupSessionTools(base({ configured: [group('Phone', 'work', [['a', 'allow'], ['b', 'off']])], lastCallNote: 'No model call yet.' }));
		expect(view.checked).toBe(false);
		expect(view.groups[0]!.title).toBe('Phone · work');
		expect(view.groups[0]!.summary).toBe('Phone · work — 1 tool');
		expect(view.groups[0]!.rows.map((r) => r.state)).toEqual(['unchecked', 'off']);
		expect(view.groups[0]!.missing).toBe(0);
	});
});
