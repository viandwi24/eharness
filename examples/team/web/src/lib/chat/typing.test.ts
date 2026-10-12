import { describe, expect, test } from 'bun:test';
import { shouldFocusComposer } from './typing.js';

const key = (k: string, over = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...over });
const body = { tag: 'body', editable: false, inOverlay: false };

describe('shouldFocusComposer', () => {
	test('a letter with focus on the body or a button goes to the composer', () => {
		expect(shouldFocusComposer(key('h'), body)).toBe(true);
		expect(shouldFocusComposer(key('h'), { ...body, tag: 'button' })).toBe(true);
	});
	test('shortcuts, special keys, fields and overlays keep their meaning', () => {
		expect(shouldFocusComposer(key('k', { metaKey: true }), body)).toBe(false);
		expect(shouldFocusComposer(key('Enter'), body)).toBe(false);
		expect(shouldFocusComposer(key('ArrowDown'), body)).toBe(false);
		expect(shouldFocusComposer(key('a'), { ...body, tag: 'input', editable: true })).toBe(false);
		expect(shouldFocusComposer(key('1'), { ...body, tag: 'div', inOverlay: true })).toBe(false);
		expect(shouldFocusComposer(key('a', { defaultPrevented: true }), body)).toBe(false);
	});
	test('space still presses a focused button', () => {
		expect(shouldFocusComposer(key(' '), { ...body, tag: 'button' })).toBe(false);
	});
});
