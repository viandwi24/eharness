/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isEmptyAssistant, uniqueById, withoutEmptyAssistant } from './messages.ts';

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
