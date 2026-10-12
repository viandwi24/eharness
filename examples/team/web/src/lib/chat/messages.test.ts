/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { editableInput, endingErrorNoticeId, endsInErrorNotice, isEmptyAssistant, regenerateTarget, uniqueById, withoutEmptyAssistant } from './messages.ts';

describe('uniqueById', () => {
	test('returns the same list when ids are unique', () => {
		const list = [{ id: 'a' }, { id: 'b' }];
		expect(uniqueById(list)).toBe(list);
	});
	test('keeps the last copy of a repeated id and reports it', () => {
		const seen: string[] = [];
		const out = uniqueById(
			[
				{ id: 'a', v: 1 },
				{ id: 'b', v: 1 },
				{ id: 'a', v: 2 }
			],
			(id) => seen.push(id)
		);
		expect(out).toEqual([
			{ id: 'b', v: 1 },
			{ id: 'a', v: 2 }
		]);
		expect(seen).toEqual(['a']);
	});
});

describe('empty assistant messages', () => {
	const empty = { role: 'assistant' as const, parts: [{ type: 'step-start' as const }] };
	const text = { role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'hi' }] };
	test('only step markers or blank text count as empty', () => {
		expect(isEmptyAssistant(empty)).toBe(true);
		expect(isEmptyAssistant({ role: 'assistant', parts: [] })).toBe(true);
		expect(isEmptyAssistant({ role: 'assistant', parts: [{ type: 'text', text: '  ' }] })).toBe(true);
		expect(isEmptyAssistant(text)).toBe(false);
		expect(isEmptyAssistant({ role: 'user', parts: [] })).toBe(false);
	});
	test('filtering keeps the same array when nothing is hidden', () => {
		const list = [text];
		expect(withoutEmptyAssistant(list)).toBe(list);
		expect(withoutEmptyAssistant([empty, text])).toEqual([text]);
	});
});

describe('regenerateTarget / editableInput / endsInErrorNotice', () => {
	const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] }) as never;
	const asst = (id: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }) as never;
	const notice = (id: string, level: string) =>
		({ id, role: 'assistant', metadata: { eharness: { kind: 'eh.notice' } }, parts: [{ type: 'data-eh.notice', data: { level, message: 'x' } }] }) as never;

	test('regenerate targets the newest reply, skipping kind messages, never a user message', () => {
		expect(regenerateTarget([user('1', 'a'), asst('2'), notice('3', 'error')])?.id).toBe('2');
		expect(regenerateTarget([user('1', 'a'), asst('2'), user('3', 'b')])).toBeUndefined();
		expect(regenerateTarget([])).toBeUndefined();
	});
	test('edit returns text and files of a user message only', () => {
		expect(editableInput(user('1', 'hello'))?.text).toBe('hello');
		expect(editableInput(asst('2'))).toBeUndefined();
		expect(editableInput(user('3', '  '))).toBeUndefined();
	});
	test('an error notice after the last user message is detected', () => {
		expect(endsInErrorNotice([user('1', 'a'), asst('2'), notice('3', 'error')])).toBe(true);
		expect(endsInErrorNotice([user('1', 'a'), notice('3', 'warning')])).toBe(false);
		expect(endsInErrorNotice([notice('3', 'error'), user('1', 'a')])).toBe(false);
	});
	test('the ending notice is identified, so an old one is not mistaken for a new failure', () => {
		expect(endingErrorNoticeId([user('1', 'a'), asst('2'), notice('3', 'error')])).toBe('3');
		expect(endingErrorNoticeId([notice('3', 'error'), user('4', 'b')])).toBeUndefined();
	});
});
