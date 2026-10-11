/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { belongsToThread, chatHref, chatSessionAgent, cleanTitle, pickThread, splitThreads, threadHref, threadSourceBadge, threadSourceHint, threadTitle } from './model.ts';

describe('thread model', () => {
	test('title: name, else the last words, else New chat', () => {
		expect(threadTitle({ title: ' Plan ', preview: 'x' })).toBe('Plan');
		expect(threadTitle({ title: null, preview: 'Where are the scripts?' })).toBe('Where are the scripts?');
		expect(threadTitle({ title: null, preview: 'a'.repeat(80) })).toHaveLength(48);
		expect(threadTitle({ title: null, preview: null })).toBe('New chat');
	});
	test('the hint of a channel badge says it is readable and continuable, and not posted back', () => {
		expect(threadSourceHint('telegram · Ops')).toContain('telegram · Ops');
		expect(threadSourceHint('telegram · Ops')).toContain('not posted to the chat');
	});
	test('the default is the newest web thread; a channel thread opens when asked for', () => {
		const threads = [
			{ id: 't-channel', sessionId: 'channel:c1:room', source: 'channel' as const },
			{ id: 't-web', sessionId: 'chat:a:1', source: 'web' as const }
		];
		expect(pickThread(threads, null)?.id).toBe('t-web');
		expect(pickThread([threads[0]], null)?.id).toBe('t-channel');
		expect(pickThread(threads, 'channel:c1:room')?.id).toBe('t-channel');
		expect(pickThread(threads, 't-web')?.id).toBe('t-web');
	});
	test('source badge: none for the web, the label (or Channel) otherwise', () => {
		expect(threadSourceBadge({ source: 'web', sourceLabel: null })).toBeNull();
		expect(threadSourceBadge({ source: 'channel', sourceLabel: 'Ops group' })).toBe('Ops group');
		expect(threadSourceBadge({ source: 'channel', sourceLabel: null })).toBe('Channel');
	});
	test('pick: the one asked for, else the first', () => {
		const list = [
			{ id: 'a', sessionId: 'dm:x' },
			{ id: 'b', sessionId: 'chat:x:b' }
		];
		expect(pickThread(list, 'b')?.id).toBe('b');
		expect(pickThread(list, 'dm:x')?.id).toBe('a');
		expect(chatHref('chat:x:b')).toBe('/a/x?t=chat%3Ax%3Ab');
		expect(chatHref('program:p:1')).toBeUndefined();
		expect(pickThread(list, 'gone')?.id).toBe('a');
		expect(pickThread(list, null)?.id).toBe('a');
		expect(pickThread([], 'a')).toBeUndefined();
	});
	test('split keeps order inside each group', () => {
		const { open, archived } = splitThreads([
			{ id: 1, archivedAt: null },
			{ id: 2, archivedAt: 5 },
			{ id: 3, archivedAt: null }
		]);
		expect(open.map((t) => t.id)).toEqual([1, 3]);
		expect(archived.map((t) => t.id)).toEqual([2]);
	});
	test('chat session ids: threads yes, children and other sessions no', () => {
		expect(chatSessionAgent('dm:a1')).toBe('a1');
		expect(chatSessionAgent('chat:a1:t9')).toBe('a1');
		expect(chatSessionAgent('chat:a1:t9:agent:call')).toBeUndefined();
		expect(chatSessionAgent('dm:a1:agent:call')).toBeUndefined();
		expect(chatSessionAgent('program:p:1')).toBeUndefined();
		expect(chatSessionAgent(null)).toBeUndefined();
	});
	test('a session belongs to a thread when it is the thread or a child of it', () => {
		expect(belongsToThread('chat:a:t', 'chat:a:t')).toBe(true);
		expect(belongsToThread('chat:a:t:agent:c', 'chat:a:t')).toBe(true);
		expect(belongsToThread('chat:a:t2', 'chat:a:t')).toBe(false);
	});
	test('href and title cleaning', () => {
		expect(threadHref('a', 't 1')).toBe('/a/a?t=t%201');
		expect(cleanTitle('  a   b ')).toBe('a b');
		expect(cleanTitle('   ')).toBeNull();
	});
});
