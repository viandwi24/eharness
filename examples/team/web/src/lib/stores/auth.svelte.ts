import { apiBase, authFetch } from '../api/index';
import { parseSession, type SessionState } from '../auth';

/** Whether the server asks for a login, and whether this browser has one (`GET /auth/session`). */
export const auth = $state<SessionState & { checked: boolean }>({ required: false, authenticated: true, checked: false });

const base = apiBase.replace(/\/+$/, '');

/** Ask the server; a failed or odd answer means "no login" (the normal reachability UI takes over). */
export async function checkSession(): Promise<SessionState> {
	let next: SessionState = { required: false, authenticated: true };
	try {
		const res = await authFetch(`${base}/auth/session`, { headers: { accept: 'application/json' } });
		next = parseSession(await res.json().catch(() => undefined));
	} catch {
		// unreachable: keep the defaults
	}
	auth.required = next.required;
	auth.authenticated = next.authenticated;
	auth.checked = true;
	return next;
}

export type LoginResult = { ok: true } | { ok: false; message: string };

/** `POST /auth/login`. Never throws: the message is shown on the form. */
export async function signIn(password: string): Promise<LoginResult> {
	try {
		const res = await authFetch(`${base}/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ password })
		});
		if (res.ok) return { ok: true };
		const body = (await res.json().catch(() => undefined)) as { error?: { message?: unknown } } | undefined;
		const message = typeof body?.error?.message === 'string' ? body.error.message : `Sign in failed (${res.status}).`;
		return { ok: false, message };
	} catch {
		return { ok: false, message: 'Cannot reach the server.' };
	}
}

/** `POST /auth/logout`, then back to the login page (a full navigation drops every in-memory store). */
export async function signOut(): Promise<void> {
	try {
		await authFetch(`${base}/auth/logout`, { method: 'POST' });
	} catch {
		// the cookie is cleared by the response; nothing else to do offline
	}
	location.assign('/login');
}
