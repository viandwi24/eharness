import { createHarnessClient } from 'eharness/client';
import { createBackoff } from './backoff';
import { createAuthFetch, goToLogin } from './auth-fetch';
import { createClient, toApiError } from './client';

export * from './client';

declare const __PUBLIC_API_URL__: string;
declare const __PUBLIC_TEAM_TOKEN__: string;

const TOKEN_KEY = 'team.token';

/**
 * Token: the one saved from the Settings page (localStorage) wins, else the build-time
 * `PUBLIC_TEAM_TOKEN` (a dev convenience). Saving a token on Settings must always take effect.
 */
export function getToken(): string | null {
	try {
		const saved = localStorage.getItem(TOKEN_KEY);
		if (saved) return saved;
	} catch {
		// storage unavailable: fall back to the build-time token
	}
	return __PUBLIC_TEAM_TOKEN__ || null;
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
/** Shared gate: the live store shows "cannot reach the server" while it is down, and Retry opens it. */
export const reachability = createBackoff();

/** Every API call: sends the session cookie and redirects to /login on 401 AUTH_REQUIRED. */
export const authFetch: typeof fetch = createAuthFetch((input, init) => globalThis.fetch(input, init), goToLogin);

export const api = createClient({ baseUrl: __PUBLIC_API_URL__ || '/api', getToken, reachability, fetch: authFetch });

export const apiBase: string = __PUBLIC_API_URL__ || '/api';

/**
 * The `eharness/http` routes (chat, session reads, attention answers, activity feed): typed client
 * of the library. The token feeds its headers on every request (`undefined` is dropped); `/health`
 * is never cached by the client (it is the restart probe).
 */
export const harness = createHarnessClient({
	baseUrl: apiBase,
	fetch: authFetch,
	headers: () => {
		const token = getToken();
		return { authorization: token ? `Bearer ${token}` : undefined };
	}
});

/**
 * Fetch a library file's bytes with the token (an `<img>` / `<iframe>` cannot send the bearer
 * header). `inline` asks for images and PDF to be served for display; the result is a Blob.
 */
export async function fetchLibraryBlob(path: string, o: { inline?: boolean; signal?: AbortSignal } = {}): Promise<Blob> {
	const q = new URLSearchParams({ path, ...(o.inline ? { inline: 'true' } : { raw: 'true' }) });
	const token = getToken();
	const res = await authFetch(`${apiBase.replace(/\/+$/, '')}/library/file?${q}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		signal: o.signal
	});
	if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
	return res.blob();
}

export type UploadedFile = { path: string; name: string; mediaType: string; size: number; version: string; url: string };

/** Upload a file into `/uploads` (multipart; the typed JSON client cannot send forms). */
export async function uploadLibraryFile(file: File): Promise<UploadedFile> {
	const form = new FormData();
	form.set('file', file);
	const token = getToken();
	const res = await authFetch(`${apiBase.replace(/\/+$/, '')}/library/files`, {
		method: 'POST',
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: form
	});
	const body: unknown = await res.json().catch(() => undefined);
	if (!res.ok) throw toApiError(res.status, body);
	return body as UploadedFile;
}
