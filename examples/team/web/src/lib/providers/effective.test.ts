import { describe, expect, test } from 'bun:test';
import { effectiveModel, effectiveModelText } from './effective.js';
import type { ProviderProfile } from './store-core.js';

const p = (id: string, label: string, isDefault: boolean, defaultModel: string): ProviderProfile => ({ id, label, isDefault, defaultModel }) as unknown as ProviderProfile;
const profiles = [p('openrouter', 'OpenRouter', true, 'deepseek/v4'), p('gateway', 'Gateway', false, 'anthropic/x')];
const none = { profileId: null, modelId: null };

describe('effectiveModel', () => {
	test('nothing picked: the default profile and its default model', () => {
		expect(effectiveModelText(effectiveModel(profiles, none, none)!)).toBe('OpenRouter · deepseek/v4');
	});
	test('the workspace pick applies to an agent without its own', () => {
		expect(effectiveModel(profiles, none, { profileId: 'gateway', modelId: 'm1' })).toMatchObject({ profileId: 'gateway', modelId: 'm1' });
	});
	test('an agent on a profile uses that profile default, not the workspace model', () => {
		expect(effectiveModel(profiles, { profileId: 'gateway', modelId: null }, { profileId: 'openrouter', modelId: 'm1' })).toMatchObject({ profileId: 'gateway', modelId: 'anthropic/x' });
	});
	test('no profiles, no answer', () => {
		expect(effectiveModel([], none, none)).toBeUndefined();
	});
});
