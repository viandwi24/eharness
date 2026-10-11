import { createHarnessClient } from 'eharness/client';
import { createBackoff } from './backoff';
import { createClient, toApiError } from './client';

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
/** Shared gate: the live store shows "cannot reach the server" while it is down, and Retry opens it. */
export const reachability = createBackoff();

export const api = createClient({ baseUrl: __PUBLIC_API_URL__ || '/api', getToken, reachability });

export const apiBase: string = __PUBLIC_API_URL__ || '/api';

/**
 * The `eharness/http` routes (chat, session reads, attention answers, activity feed): typed client
 * of the library. The token feeds its headers on every request (`undefined` is dropped); `/health`
 * is never cached by the client (it is the restart probe).
 */
export const harness = createHarnessClient({
	baseUrl: apiBase,
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
	const res = await fetch(`${apiBase.replace(/\/+$/, '')}/library/file?${q}`, {
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
	const res = await fetch(`${apiBase.replace(/\/+$/, '')}/library/files`, {
		method: 'POST',
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: form
	});
	const body: unknown = await res.json().catch(() => undefined);
	if (!res.ok) throw toApiError(res.status, body);
	return body as UploadedFile;
}
