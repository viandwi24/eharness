/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import {
	buildChatRequest,
	classifyChatResponse,
	emptyStreamResponse,
	mergeOlder,
	replaceTail,
	shouldResume,
	uploadErrorText
} from './http.ts';

const m = (id: string, role: 'user' | 'assistant' = 'user'): UIMessage =>
	({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage;

describe('buildChatRequest', () => {
	test('sends only the last message', () => {
		const { body } = buildChatRequest({ id: 'a1', messages: [m('1'), m('2', 'assistant'), m('3')] });
		expect(body.id).toBe('a1');
		expect(body.messages.map((x) => x.id)).toEqual(['3']);
		expect('trigger' in body).toBe(false);
	});
	test('keeps trigger and messageId when present', () => {
		const { body } = buildChatRequest({ id: 'a1', messages: [m('1')], trigger: 'regenerate-message', messageId: 'x' });
		expect([body.trigger, body.messageId]).toEqual(['regenerate-message', 'x']);
	});
});

describe('classifyChatResponse', () => {
	test('200 is a stream', () => expect(classifyChatResponse(200, undefined)).toEqual({ kind: 'stream' }));
	test('202 is a steer', () => {
		expect(classifyChatResponse(202, { inboxId: 'i1', delivered: 'steer', target: 'remote' })).toEqual({
			kind: 'steered',
			inboxId: 'i1',
			target: 'remote'
		});
	});
	test('409 busy reads the server code', () => {
		const o = classifyChatResponse(409, { error: { code: 'EH_SESSION_BUSY', message: 'busy' } });
		expect(o.kind).toBe('busy');
		expect(o.kind === 'busy' && o.code).toBe('EH_SESSION_BUSY');
	});
	test('other statuses are errors with the envelope message', () => {
		expect(classifyChatResponse(404, { error: { code: 'NOT_FOUND', message: 'Unknown agent' } })).toEqual({
			kind: 'error',
			status: 404,
			message: 'Unknown agent'
		});
		expect(classifyChatResponse(500, '<html>')).toEqual({ kind: 'error', status: 500, message: 'Request failed (500)' });
	});
});

describe('emptyStreamResponse', () => {
	test('is a finished UI message stream', async () => {
		const r = emptyStreamResponse();
		expect(r.headers.get('content-type')).toBe('text/event-stream');
		expect(await r.text()).toContain('[DONE]');
	});
});

describe('shouldResume', () => {
	test('running here or anywhere', () => {
		expect(shouldResume({ running: true, activeTurn: null })).toBe(true);
		expect(shouldResume({ running: false, activeTurn: { turnId: 't' } })).toBe(true);
		expect(shouldResume({ running: false, activeTurn: null })).toBe(false);
		expect(shouldResume(undefined)).toBe(false);
	});
});

describe('history merging', () => {
	test('mergeOlder prepends and skips duplicates', () => {
		expect(mergeOlder([m('c'), m('d')], [m('a'), m('b'), m('c')]).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
	});
	test('replaceTail keeps older pages and swaps the tail', () => {
		const next = replaceTail([m('a'), m('b'), m('c')], [{ ...m('c'), role: 'assistant' }, m('d')]);
		expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(next[2].role).toBe('assistant');
		expect(replaceTail([m('a')], [])).toEqual([m('a')]);
	});
});

describe('uploadErrorText', () => {
	test('names the file for size and type problems', () => {
		expect(uploadErrorText(413, undefined, 'big.pdf')).toContain('big.pdf is too large');
		expect(uploadErrorText(400, { error: { message: 'type not allowed' } }, 'a.exe')).toBe('a.exe was rejected: type not allowed');
		expect(uploadErrorText(500, undefined, 'x.txt')).toBe('Could not upload x.txt');
	});
});

describe('classifyChatResponse: stale answers', () => {
	test('409 ALREADY_ANSWERED is stale (quiet), other 409s stay busy', () => {
		expect(classifyChatResponse(409, { error: { code: 'ALREADY_ANSWERED', message: 'gone' } })).toEqual({ kind: 'stale', message: 'gone' });
		expect(classifyChatResponse(409, { error: { code: 'EH_SESSION_BUSY', message: 'x' } }).kind).toBe('busy');
	});
});
