import { describe, expect, test } from 'bun:test';
import { addCustomModel, disableAllModels, enableAllModels, filterModels, formatContext, formatPrice, formatPricing, hasModelPolicy, isModelEnabled, setModelEnabled, type ProviderModel } from './models';

const m = (id: string, name = id): ProviderModel => ({ id, name, source: 'catalog' });

describe('formatting', () => {
	test('context window', () => {
		expect(formatContext(1_000_000)).toBe('1M');
		expect(formatContext(200_000)).toBe('200K');
		expect(formatContext(8_192)).toBe('8.2K');
		expect(formatContext(1_048_576)).toBe('1M');
		expect(formatContext(undefined)).toBe('');
		expect(formatContext(512)).toBe('512');
	});

	test('prices per 1M tokens', () => {
		expect(formatPrice(3)).toBe('$3');
		expect(formatPrice(0.25)).toBe('$0.25');
		expect(formatPrice(0)).toBe('free');
		expect(formatPrice(15.04)).toBe('$15');
		expect(formatPricing({ input: 3, output: 15 })).toBe('$3 in / $15 out');
		expect(formatPricing(undefined)).toBe('');
	});
});

describe('filterModels', () => {
	const list = [m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'), m('openai/gpt-5.6', 'GPT 5.6'), m('meta/llama:free', 'Llama Free')];
	test('empty query returns everything, capped', () => {
		expect(filterModels(list, '').total).toBe(3);
		expect(filterModels(list, '', 2).items).toHaveLength(2);
	});
	test('every word must match id or name', () => {
		expect(filterModels(list, 'claude 5.5').items.map((x) => x.id)).toEqual(['anthropic/claude-sonnet-5.5']);
		expect(filterModels(list, 'LLAMA').items).toHaveLength(1);
		expect(filterModels(list, 'gpt llama').total).toBe(0);
	});
});

describe('model policy', () => {
	test('no policy: everything is on', () => {
		expect(isModelEnabled(undefined, 'a')).toBe(true);
		expect(hasModelPolicy(undefined)).toBe(false);
		expect(hasModelPolicy({ extra: [{ id: 'x' }] })).toBe(false);
	});
	test('deny mode: switching off adds to deny, back on clears the policy', () => {
		const off = setModelEnabled(undefined, 'a', false);
		expect(off).toEqual({ deny: ['a'] });
		expect(isModelEnabled(off ?? undefined, 'a')).toBe(false);
		expect(isModelEnabled(off ?? undefined, 'b')).toBe(true);
		expect(setModelEnabled(off ?? undefined, 'a', true)).toBeNull();
	});
	test('allow mode: on adds to allow, off removes it', () => {
		const none = disableAllModels(undefined);
		expect(none).toEqual({ allow: [] });
		expect(isModelEnabled(none, 'a')).toBe(false);
		const a = setModelEnabled(none, 'a', true);
		expect(a).toEqual({ allow: ['a'] });
		expect(isModelEnabled(a ?? undefined, 'a')).toBe(true);
		expect(isModelEnabled(a ?? undefined, 'b')).toBe(false);
		expect(setModelEnabled(a ?? undefined, 'a', false)).toEqual({ allow: [] });
	});
	test('a glob in allow: switching one model off denies it by id', () => {
		const p = { allow: ['openai/*'] };
		const next = setModelEnabled(p, 'openai/gpt-x', false);
		expect(next).toEqual({ allow: ['openai/*'], deny: ['openai/gpt-x'] });
		expect(isModelEnabled(next ?? undefined, 'openai/gpt-x')).toBe(false);
		expect(isModelEnabled(next ?? undefined, 'openai/gpt-y')).toBe(true);
		expect(isModelEnabled(next ?? undefined, 'meta/llama')).toBe(false);
	});
	test('extras skip allow but not deny; enable all keeps them', () => {
		const p = { allow: [], extra: [{ id: 'mine' }] };
		expect(isModelEnabled(p, 'mine')).toBe(true);
		expect(isModelEnabled(disableAllModels(p), 'mine')).toBe(false);
		expect(enableAllModels(disableAllModels(p))).toEqual({ extra: [{ id: 'mine' }] });
		expect(enableAllModels({ allow: ['a'], deny: ['b'] })).toBeNull();
	});
});

describe('addCustomModel', () => {
	test('allow-list mode: extra and allow, out of deny', () => {
		const next = addCustomModel({ allow: ['a'], deny: ['x', 'new'] }, 'new');
		expect(next).toEqual({ allow: ['a', 'new'], deny: ['x'], extra: [{ id: 'new' }] });
		expect(isModelEnabled(next, 'new')).toBe(true);
	});
	test('deny-only mode: extra, deny entry dropped, no allow list created', () => {
		const next = addCustomModel({ deny: ['new'] }, 'new');
		expect(next).toEqual({ extra: [{ id: 'new' }] });
	});
	test('a deny pattern still hides it', () => {
		expect(isModelEnabled(addCustomModel({ deny: ['n*'] }, 'new'), 'new')).toBe(false);
	});
	test('is idempotent', () => {
		const once = addCustomModel(undefined, 'm');
		expect(addCustomModel(once, 'm')).toEqual(once);
	});
});
