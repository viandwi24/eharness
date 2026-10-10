import type { ApiClient, ToolInfo } from '../api/client';

export const emptyToolsState = (): { tools: ToolInfo[]; loaded: boolean; error: string | null } => ({
	tools: [],
	loaded: false,
	error: null
});

export function createToolsCore(api: ApiClient, state: ReturnType<typeof emptyToolsState>) {
	return {
		state,
		async load(): Promise<void> {
			if (state.loaded) return;
			try {
				state.tools = (await api.get('/tools')).tools;
				state.loaded = true;
				state.error = null;
			} catch (e) {
				state.error = e instanceof Error ? e.message : String(e);
			}
		}
	};
}
