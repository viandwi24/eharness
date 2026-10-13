// Typed client of the artifact API (plan P45 "API contract"). Hand-written against the contract;
// the generated schema can replace these types once the server publishes it.
import { apiBase, authFetch, getToken, toApiError } from '#lib/api/index.js';

export type ArtifactFile = { path: string; size: number; mediaType: string };
export type ArtifactSummary = {
	id: string;
	kind: string;
	title: string;
	description: string;
	dir: string;
	entry: string;
	agentId: string | null;
	sessionId: string | null;
	version: number;
	visibility: 'private' | 'public';
	shareUrl: string | null;
	shareVersion: number | null;
	createdAt: number | string;
	updatedAt: number | string;
};
export type Artifact = ArtifactSummary & { files: ArtifactFile[] };
export type ArtifactVersion = { n: number; note: string; by: string; at: number | string; entry: string; files: ArtifactFile[] };
export type SignedUrl = { url: string; expiresAt: number | string };
export type ArtifactOrigin = { sessionId?: string; messageId: string; block: number };

/** Epoch milliseconds of a timestamp the server may send as a number or an ISO string. */
export const toMs = (v: number | string): number => (typeof v === 'string' ? Date.parse(v) : v);

const base = (): string => apiBase.replace(/\/+$/, '');

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const token = getToken();
	const res = await authFetch(`${base()}${path}`, {
		method,
		signal,
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
	if (!res.ok) throw toApiError(res.status, parsed);
	return parsed as T;
}

const qs = (o: Record<string, string | number | undefined>): string => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
	const s = p.toString();
	return s ? `?${s}` : '';
};

export const artifactsApi = {
	list: (q: { query?: string; kind?: string; agentId?: string; limit?: number; cursor?: string } = {}, signal?: AbortSignal) =>
		call<{ items: ArtifactSummary[]; nextCursor: string | null }>('GET', `/artifacts${qs(q)}`, undefined, signal),
	get: (id: string, signal?: AbortSignal) => call<Artifact>('GET', `/artifacts/${encodeURIComponent(id)}`, undefined, signal),
	versions: (id: string) => call<ArtifactVersion[]>('GET', `/artifacts/${encodeURIComponent(id)}/versions`),
	viewUrl: (id: string, o: { version?: number; path?: string } = {}) => call<SignedUrl>('POST', `/artifacts/${encodeURIComponent(id)}/view-url`, o),
	create: (b: { kind: string; title: string; files: { path: string; content: string }[]; origin?: ArtifactOrigin }) => call<Artifact>('POST', '/artifacts', b),
	patch: (id: string, b: { title?: string; visibility?: 'private' | 'public'; shareVersion?: number | null }) => call<Artifact>('PATCH', `/artifacts/${encodeURIComponent(id)}`, b),
	remove: (id: string) => call<void>('DELETE', `/artifacts/${encodeURIComponent(id)}`),
	/** A library file's signed raw view (thumbnails, the file viewer). */
	libraryViewUrl: (path: string) => call<SignedUrl>('POST', '/library/view-url', { path })
};

/** The export file of an artifact (the request needs the bearer token, so it is fetched as a blob). */
export async function exportArtifact(id: string, format: string): Promise<{ blob: Blob; filename: string }> {
	const token = getToken();
	const res = await authFetch(`${base()}/artifacts/${encodeURIComponent(id)}/export/${encodeURIComponent(format)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
	if (!res.ok) throw toApiError(res.status, await res.json().catch(() => undefined));
	const cd = res.headers.get('content-disposition') ?? '';
	const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
	return { blob: await res.blob(), filename: name ? decodeURIComponent(name) : `${id}.${format}` };
}

/** A signed URL remembered until shortly before it expires (an expired one is fetched again, A-12). */
export function cachedViewUrl(fetchUrl: () => Promise<SignedUrl>): () => Promise<string> {
	let cur: SignedUrl | undefined;
	return async () => {
		if (!cur || toMs(cur.expiresAt) - Date.now() < 60_000) cur = await fetchUrl();
		return cur.url;
	};
}
