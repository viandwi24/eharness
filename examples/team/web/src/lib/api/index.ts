import { createClient } from './client';

export * from './client';

declare const __PUBLIC_API_URL__: string;
declare const __PUBLIC_TEAM_TOKEN__: string;

const TOKEN_KEY = 'team.token';

/** Token: `PUBLIC_TEAM_TOKEN` wins, else the one saved from the Settings page (localStorage). */
export function getToken(): string | null {
	if (__PUBLIC_TEAM_TOKEN__) return __PUBLIC_TEAM_TOKEN__;
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setToken(token: string): void {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage unavailable: the token lives only until reload
	}
}

/**
 * Base URL: `PUBLIC_API_URL`, else `/api`, which `vite dev` proxies to the server
 * (default http://localhost:4000, override with `TEAM_API_PROXY`).
 */
export const api = createClient({ baseUrl: __PUBLIC_API_URL__ || '/api', getToken });
