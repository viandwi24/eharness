// Pure helpers of the custom connector UI ("Add custom connector", like Claude): validation of the
// name and URL, what a probe means, the review choices, request headers, and how each custom
// connection looks in the directory. Framework-free so it is unit tested.
import type { Capability, Connection, CustomConnectorBody, CustomProbe } from '../api/client';

export type SignIn = CustomConnectorBody['signIn'];

export const SIGN_IN_OPTIONS: { value: SignIn; label: string; hint: string }[] = [
	{ value: 'now', label: 'Sign in now', hint: 'Sign in to the server right after adding it.' },
	{ value: 'later', label: 'Sign in when needed', hint: 'Add it now; agents get its tools once you sign in.' },
	{ value: 'none', label: 'No sign in', hint: 'The server needs no sign in.' }
];

/** https, or http on this machine (the server enforces the same rule). */
export function isAllowedUrl(value: string): boolean {
	try {
		const u = new URL(value.trim());
		return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
	} catch {
		return false;
	}
}

export type DetailsErrors = { name?: string; url?: string };

/** Errors of step 1 (name + URL), empty when it can continue. */
export function validateDetails(name: string, url: string): DetailsErrors {
	const errors: DetailsErrors = {};
	if (name.trim() === '') errors.name = 'Give it a name.';
	else if (name.trim().length > 60) errors.name = 'Keep the name under 60 characters.';
	if (url.trim() === '') errors.url = 'Enter the server URL.';
	else if (!isAllowedUrl(url)) errors.url = 'Use an https URL (http works only on localhost).';
	return errors;
}

/** The choice a probe preselects: OAuth detected means sign in now, anything else no sign in. */
export const defaultSignIn = (probe: Pick<CustomProbe, 'detected'> | null): SignIn => (probe?.detected === 'oauth' ? 'now' : 'none');

/** One line under the review heading. */
export function detectionText(probe: CustomProbe | null): string {
	if (probe === null) return '';
	if (probe.detected === 'oauth') return probe.oauth?.discovered === false ? 'This server asks you to sign in, but did not say how. You may need your own OAuth client.' : 'This server asks you to sign in with OAuth.';
	if (probe.detected === 'none') return probe.tools !== undefined ? `No sign in needed. ${probe.tools} ${probe.tools === 1 ? 'tool' : 'tools'} found.` : 'No sign in needed.';
	return `${probe.message} You can still add it.`;
}

/** The server can not register a client itself: the user should bring one. */
export const needsOwnClient = (probe: CustomProbe | null): boolean => probe?.detected === 'oauth' && probe.oauth?.dynamicRegistration === false;

export type HeaderRow = { key: string; value: string };

/** Header rows to the request body: blank rows dropped, names trimmed. */
export function headersOf(rows: HeaderRow[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const r of rows) if (r.key.trim() !== '') out[r.key.trim()] = r.value;
	return Object.keys(out).length ? out : undefined;
}

export const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Names of rows that are not valid HTTP header names (letters, digits, hyphens). */
export const badHeaderNames = (rows: HeaderRow[]): string[] => rows.map((r) => r.key.trim()).filter((k) => k !== '' && !HEADER_NAME.test(k));

export type ReviewForm = { name: string; url: string; signIn: SignIn; clientId: string; clientSecret: string; headers: HeaderRow[]; availableToAll: boolean };

/** The POST body of "Add" (the OAuth client is only sent when signing in is part of the choice). */
export function createBody(f: ReviewForm, agentId?: string): CustomConnectorBody {
	const headers = headersOf(f.headers);
	return {
		name: f.name.trim(),
		url: f.url.trim(),
		signIn: f.signIn,
		...(f.signIn !== 'none' && f.clientId.trim() !== '' ? { oauthClient: { clientId: f.clientId.trim(), ...(f.clientSecret.trim() ? { clientSecret: f.clientSecret.trim() } : {}) } } : {}),
		...(headers ? { headers } : {}),
		...(agentId ? { scope: 'agent' as const, scopeId: agentId } : { availableToAll: f.availableToAll })
	};
}

export const canAdd = (f: ReviewForm): boolean => Object.keys(validateDetails(f.name, f.url)).length === 0 && badHeaderNames(f.headers).length === 0;

// --- the directory ---------------------------------------------------------------------------

/** Custom connections, each its own card (oldest first, so cards keep their place). */
export const customConnections = (connections: Connection[]): Connection[] => connections.filter((c) => c.custom).sort((a, b) => a.createdAt - b.createdAt);

export type CustomState = 'connected' | 'needs-sign-in' | 'error' | 'off';

/** `needs-sign-in`: added with "Sign in when needed" (or the sign-in lapsed) and not signed in yet. */
export function customState(c: Pick<Connection, 'status' | 'enabled'>): CustomState {
	if (!c.enabled || c.status === 'disabled') return 'off';
	if (c.status === 'needs-auth') return 'needs-sign-in';
	if (c.status === 'error') return 'error';
	return 'connected';
}

export const CUSTOM_STATE_LABEL: Record<CustomState, string> = { connected: 'Connected', 'needs-sign-in': 'Sign in needed', error: 'Error', off: 'Off' };

export function authLabel(c: Pick<Connection, 'settings'>): string {
	const mode = c.settings.authMode;
	return mode === 'oauth' ? 'OAuth sign in' : mode === 'headers' ? 'Request headers' : 'No sign in';
}

/** The server host of a connection ("mcp.example.com"), for the card subtitle. */
export function hostOf(c: Pick<Connection, 'settings'>): string {
	const url = c.settings.url;
	if (typeof url !== 'string') return '';
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Two letters for the card icon: initials of the name's first two words. */
export function initialsOf(name: string): string {
	const words = name.trim().split(/[\s_-]+/).filter(Boolean);
	if (words.length === 0) return '?';
	const letters = words.length === 1 ? Array.from(words[0]!).slice(0, 2) : [Array.from(words[0]!)[0]!, Array.from(words[1]!)[0]!];
	return letters.join('').toUpperCase();
}

/** Whether a custom card matches the search box (name, host). */
export function matchesCustom(c: Connection, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || c.label.toLowerCase().includes(q) || hostOf(c).toLowerCase().includes(q) || 'custom'.includes(q);
}

/** Capabilities of a connection grouped for the detail: reads first, then what changes data. */
export function toolGroups(caps: Capability[]): { reads: Capability[]; writes: Capability[] } {
	return { reads: caps.filter((c) => c.kind === 'read'), writes: caps.filter((c) => c.kind !== 'read') };
}

export const toolCount = (caps: Capability[]): number => caps.reduce((n, c) => n + c.tools.length, 0);
