/** Pure helpers of the password login (no DOM, no fetch): where to send a signed-out browser. */

export const LOGIN_PATH = '/login';

/** True for `/login` (and `/login/...`): the page that must never redirect to itself. */
export function isLoginPath(pathname: string): boolean {
	return pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);
}

/**
 * `?next=` is user-controlled: only a same-origin path is followed (`/a/b?x=1`), never an absolute
 * URL, a protocol-relative `//host` or a backslash trick. Anything else falls back to `/`.
 */
export function safeNext(next: string | null | undefined): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
	if (isLoginPath(next.split(/[?#]/)[0] ?? '')) return '/';
	return next;
}

/** The login URL that returns to `path` (pathname + search) afterwards, or null when already on the login page. */
export function loginRedirect(path: string): string | null {
	const pathname = path.split(/[?#]/)[0] ?? '';
	if (isLoginPath(pathname)) return null;
	const next = safeNext(path);
	return next === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/** A 401 whose error code says the session is missing (not a wrong bearer token). */
export function isAuthRequired(status: number, body: unknown): boolean {
	if (status !== 401) return false;
	const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
	return code === 'AUTH_REQUIRED';
}

/** What `GET /auth/session` answers. */
export type SessionState = { required: boolean; authenticated: boolean };

/** Parse the session probe; anything unexpected (an HTML page, an old server) means no login. */
export function parseSession(body: unknown): SessionState {
	const b = body as { required?: unknown; authenticated?: unknown } | null;
	if (b && typeof b.required === 'boolean' && typeof b.authenticated === 'boolean') {
		return { required: b.required, authenticated: b.authenticated };
	}
	return { required: false, authenticated: true };
}

/** True when the browser must go to the login page before anything else. */
export function mustSignIn(s: SessionState): boolean {
	return s.required && !s.authenticated;
}
