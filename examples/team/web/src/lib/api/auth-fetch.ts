import { isAuthRequired, loginRedirect } from '../auth';

/**
 * A `fetch` for every API call: sends the session cookie (same origin; the vite dev proxy forwards
 * it) and, when the server answers 401 `AUTH_REQUIRED`, calls `onSignedOut` once (the redirect to
 * the login page). The response is returned unchanged, so callers still see the error.
 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createAuthFetch(base: FetchLike, onSignedOut: () => void): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const res = await base(input, { credentials: 'same-origin', ...init });
		if (res.status === 401) {
			const body: unknown = await res.clone().json().catch(() => undefined);
			if (isAuthRequired(res.status, body)) onSignedOut();
		}
		return res;
	}) as typeof fetch;
}

let redirecting = false;

/** Browser side effect: go to `/login?next=<here>` (a full navigation, so every store starts clean). */
export function goToLogin(): void {
	if (redirecting || typeof location === 'undefined') return;
	const target = loginRedirect(location.pathname + location.search);
	if (!target) return;
	redirecting = true;
	location.assign(target);
}
