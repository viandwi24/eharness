import { describe, expect, test } from 'bun:test';
import { filterModels, formatContext, formatPrice, formatPricing, type ProviderModel } from './models';

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
