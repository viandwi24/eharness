import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { emptyPages, mergeNewest, prependOlder, replaceMessage } from './pages.js';

const m = (id: string, parts = 1): UIMessage => ({ id, role: 'assistant', parts: Array.from({ length: parts }, () => ({ type: 'text' as const, text: id })) });

describe('mergeNewest', () => {
	test('first page fills an empty state', () => {
		expect(mergeNewest(emptyPages(), [m('c'), m('d')], true)).toEqual({ messages: [m('c'), m('d')], hasOlder: true });
	});
	test('older pages stay, the newest page replaces its copies and appends new ones', () => {
		const state = { messages: [m('a'), m('b'), m('c', 1), m('d')], hasOlder: false };
		const out = mergeNewest(state, [m('c', 2), m('d'), m('e')], true);
		expect(out.messages.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(out.messages[2]!.parts).toHaveLength(2);
		expect(out.hasOlder).toBe(false); // the loaded range decides, not the page
	});
	test('an empty page keeps what is loaded', () => {
		const state = { messages: [m('a')], hasOlder: true };
		expect(mergeNewest(state, [], false)).toBe(state);
	});
	test('a page that leaves a hole drops the old pages', () => {
		const state = { messages: [m('a'), m('b')], hasOlder: false };
		expect(mergeNewest(state, [m('x'), m('y')], true)).toEqual({ messages: [m('x'), m('y')], hasOlder: true });
	});
	test('a full copy is kept while the parts did not change', () => {
		const fullCopy = m('c', 3);
		const state = { messages: [m('b'), fullCopy], hasOlder: false };
		expect(mergeNewest(state, [m('b'), m('c', 3)], false, new Set(['c'])).messages[1]).toBe(fullCopy);
		expect(mergeNewest(state, [m('b'), m('c', 4)], false, new Set(['c'])).messages[1]!.parts).toHaveLength(4);
	});
});

describe('prependOlder / replaceMessage', () => {
	test('puts the older page in front without duplicates', () => {
		const out = prependOlder({ messages: [m('c'), m('d')], hasOlder: true }, [m('a'), m('b'), m('c')], false);
		expect(out.messages.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(out.hasOlder).toBe(false);
	});
	test('replaces in place', () => {
		const out = replaceMessage({ messages: [m('a'), m('b')], hasOlder: false }, m('b', 5));
		expect(out.messages[1]!.parts).toHaveLength(5);
		expect(replaceMessage(out, m('zz')).messages).toHaveLength(2);
	});
});
