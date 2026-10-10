// Providers store logic: definitions + profiles (`GET /providers`) and the model lists of each
// profile (`GET /providers/profiles/{id}/models`), cached per profile. Framework-free: the
// `.svelte.ts` wrapper hands it a reactive state object.
import type { ApiClient } from '../api/client';
import type { components } from '../api/schema';

export type ProviderDefinition = components['schemas']['ProviderDefinition'];
export type ProviderProfile = components['schemas']['ProviderProfile'];
export type ProviderModel = components['schemas']['ProviderModel'];

export type ProvidersState = {
	providers: ProviderDefinition[];
	profiles: ProviderProfile[];
	loaded: boolean;
	error: string | null;
};

export const emptyProvidersState = (): ProvidersState => ({ providers: [], profiles: [], loaded: false, error: null });

export function createProvidersCore(api: ApiClient, state: ProvidersState) {
	// model lists are cached for the page's life; `revision` drops them when profiles change
	const lists = new Map<string, Promise<ProviderModel[]>>();
	// the same with the models a profile's allow / deny hides (`all=true`): the model switches
	const everything = new Map<string, Promise<ProviderModel[]>>();
	let seq = 0;

	const core = {
		state,

		async load(): Promise<void> {
			const mine = ++seq;
			try {
				const res = await api.get('/providers');
				if (mine !== seq) return;
				state.providers = res.providers;
				state.profiles = res.profiles;
				state.loaded = true;
				state.error = null;
			} catch (e) {
				if (mine === seq) state.error = e instanceof Error ? e.message : String(e);
			}
		},

		definition(id: string): ProviderDefinition | undefined {
			return state.providers.find((p) => p.id === id);
		},

		profile(id: string | null | undefined): ProviderProfile | undefined {
			return id ? state.profiles.find((p) => p.id === id) : undefined;
		},

		/** The profile agents without their own pick use. */
		defaultProfile(): ProviderProfile | undefined {
			return state.profiles.find((p) => p.isDefault);
		},

		/** Model list of a profile (cached; `refresh` asks the provider again). */
		models(profileId: string, refresh = false): Promise<ProviderModel[]> {
			const hit = lists.get(profileId);
			if (hit && !refresh) return hit;
			const p = api
				.get('/providers/profiles/{id}/models', { params: { id: profileId }, ...(refresh ? { query: { refresh: 'true' as const } } : {}) })
				.then((r) => r.models);
			lists.set(profileId, p);
			p.catch(() => {
				if (lists.get(profileId) === p) lists.delete(profileId); // a failure is not cached
			});
			return p;
		},

		/** Model list with the hidden ones too, each marked `enabled` (cached like `models`). */
		allModels(profileId: string, refresh = false): Promise<ProviderModel[]> {
			const hit = everything.get(profileId);
			if (hit && !refresh) return hit;
			const p = api
				.get('/providers/profiles/{id}/models', { params: { id: profileId }, query: { all: 'true' as const, ...(refresh ? { refresh: 'true' as const } : {}) } })
				.then((r) => r.models);
			everything.set(profileId, p);
			p.catch(() => {
				if (everything.get(profileId) === p) everything.delete(profileId);
			});
			return p;
		},

		/** Forget cached model lists (a profile changed). */
		forget(profileId?: string): void {
			if (profileId === undefined) {
				lists.clear();
				everything.clear();
			} else {
				lists.delete(profileId);
				everything.delete(profileId);
			}
		}
	};
	return core;
}

export type ProvidersStore = ReturnType<typeof createProvidersCore>;
