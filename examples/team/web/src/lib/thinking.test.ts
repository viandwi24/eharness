import { describe, expect, test } from 'bun:test';
import type { ProviderModel } from '#lib/providers/models.js';
import { thinkingChoices } from './thinking.js';

const model = (m: Partial<ProviderModel>): ProviderModel => ({ id: 'm', name: 'M', source: 'catalog', ...m }) as ProviderModel;

describe('thinkingChoices', () => {
	test('the catalog levels, weakest first; off hidden for a model that always thinks', () => {
		const flash = thinkingChoices(model({ thinking: { levels: ['max', 'high', 'low', 'none'], defaultLevel: 'high' } }));
		expect(flash.levels).toEqual(['none', 'low', 'high', 'max']);
		expect(flash.defaultLevel).toBe('high');
		const opus = thinkingChoices(model({ thinking: { levels: ['max', 'xhigh', 'high', 'medium', 'low'], mandatory: true } }));
		expect(opus.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
		expect(opus.mandatory).toBe(true);
		expect(opus.hint).toContain('cannot be turned off');
	});
	test('reasoning without levels gets the common ones; a non-reasoning model none; unknown all', () => {
		expect(thinkingChoices(model({ reasoning: true })).levels).toEqual(['none', 'low', 'medium', 'high']);
		expect(thinkingChoices(model({ reasoning: false })).unsupported).toBe(true);
		expect(thinkingChoices(model({})).levels).toHaveLength(7);
		expect(thinkingChoices(undefined).levels).toHaveLength(7);
	});
});
