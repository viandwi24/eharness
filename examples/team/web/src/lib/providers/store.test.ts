import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '../api/client';
import { createProvidersCore, emptyProvidersState } from './store-core';

function fakeApi() {
	const calls: string[] = [];
	const api = {
		get: async (path: string, o?: { params?: { id: string }; query?: { refresh?: string } }) => {
			calls.push(`${path}${o?.params ? `:${o.params.id}` : ''}${o?.query?.refresh ? '?refresh' : ''}`);
			if (path === '/providers') {
				return { providers: [{ id: 'openrouter', label: 'OpenRouter', fields: [], jsonSchema: {}, envMap: {}, canListModels: true }], profiles: [{ id: 'openrouter', isDefault: true }] };
			}
			if (o?.params?.id === 'broken') throw new Error('nope');
			return { models: [{ id: 'm', name: 'M', source: 'catalog' }] };
		}
	} as unknown as ApiClient;
	return { api, calls };
}

describe('providers store', () => {
	test('loads definitions and profiles; finds the default', async () => {
		const { api } = fakeApi();
		const core = createProvidersCore(api, emptyProvidersState());
		await core.load();
		expect(core.state.loaded).toBe(true);
		expect(core.definition('openrouter')?.label).toBe('OpenRouter');
		expect(core.defaultProfile()?.id).toBe('openrouter');
		expect(core.profile('nope')).toBeUndefined();
	});

	test('model lists are cached per profile, refreshable, and failures are not cached', async () => {
		const { api, calls } = fakeApi();
		const core = createProvidersCore(api, emptyProvidersState());
		await core.models('openrouter');
		await core.models('openrouter');
		expect(calls).toEqual(['/providers/profiles/{id}/models:openrouter']);
		await core.models('openrouter', true);
		expect(calls.at(-1)).toBe('/providers/profiles/{id}/models:openrouter?refresh');
		await expect(core.models('broken')).rejects.toThrow('nope');
		await expect(core.models('broken')).rejects.toThrow('nope');
		expect(calls.filter((c) => c.includes('broken'))).toHaveLength(2);
		core.forget();
		await core.models('openrouter');
		expect(calls.filter((c) => c.endsWith('openrouter'))).toHaveLength(2);
	});
});
