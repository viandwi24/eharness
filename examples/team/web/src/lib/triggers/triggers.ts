// Pure helpers of the Triggers page (event listeners): the form model and its conversion to the API
// body, client-side validation that mirrors the server, plain-language sentences, the prefill from an
// event, and the words of a firing. The data comes from `/triggers`, `/trigger-fires` and `/events/catalog`.
import type { components } from '../api/schema';
import { timeAgo } from '../time';
import type { EventTypeInfo, StreamEvent } from '../events/events';

export type Trigger = components['schemas']['Trigger'];
export type TriggerCreate = components['schemas']['TriggerCreate'];
export type TriggerPatch = components['schemas']['TriggerPatch'];
export type TriggerFire = components['schemas']['TriggerFire'];
export type TriggerDryRun = components['schemas']['TriggerDryRun'];
export type TriggerAction = components['schemas']['TriggerAction'];
export type TriggerFilters = components['schemas']['TriggerFilters'];
export type ActionKind = TriggerAction['kind'];
export type WakeTarget = 'chat' | 'thread' | 'triggers';
export type ActorRole = TriggerFilters['actorRoles'][number];

export const ACTION_KINDS: { id: ActionKind; label: string; hint: string }[] = [
	{ id: 'wake', label: 'Wake an agent', hint: 'The agent gets the event and your instruction, and decides what to do.' },
	{ id: 'program', label: 'Run a program', hint: 'Start one of the programs, with this event as the reason.' },
	{ id: 'notify', label: 'Notify me', hint: 'A notification in the bell, optionally also a message in your direct chat.' },
	{ id: 'webhook', label: 'Call a webhook', hint: 'Send the event to an https URL, signed with a secret.' }
];

export const WAKE_TARGETS: { id: WakeTarget; label: string; hint: string }[] = [
	{ id: 'triggers', label: 'A "Triggers" chat', hint: 'The agent works in a web chat named "Triggers", one place to read what it did.' },
	{ id: 'chat', label: 'The chat of the event', hint: 'The agent continues in the chat session where the event happened.' },
	{ id: 'thread', label: "The agent's newest web chat", hint: 'The agent continues in its most recent web chat.' }
];

export const ROLES: ActorRole[] = ['owner', 'admin', 'member', 'guest'];

export const MIN_SECRET = 16;
export const MAX_REGEX = 200;
export const MAX_NAME = 80;

export type FieldRow = { field: string; op: 'equals' | 'contains'; value: string };

export type TriggerForm = {
	name: string;
	notes: string;
	enabled: boolean;
	eventTypes: string[];
	connectionIds: string[];
	chatIds: string[];
	actorRoles: ActorRole[];
	actors: string[];
	textContains: string[];
	textRegex: string;
	emoji: string[];
	fields: FieldRow[];
	actionKind: ActionKind;
	agentId: string;
	target: WakeTarget;
	instruction: string;
	includeText: boolean;
	programId: string;
	notifyTitle: string;
	dm: boolean;
	url: string;
	/** Write-only: empty keeps the stored secret. */
	secret: string;
	/** Seconds, as typed. */
	cooldownSec: string;
	allowSelf: boolean;
};

export const emptyForm = (): TriggerForm => ({
	name: '',
	notes: '',
	enabled: true,
	eventTypes: [],
	connectionIds: [],
	chatIds: [],
	actorRoles: [],
	actors: [],
	textContains: [],
	textRegex: '',
	emoji: [],
	fields: [],
	actionKind: 'notify',
	agentId: '',
	target: 'triggers',
	instruction: '',
	includeText: false,
	programId: '',
	notifyTitle: '',
	dm: false,
	url: '',
	secret: '',
	cooldownSec: '0',
	allowSelf: false
});

export const isMessageType = (t: string): boolean => t.startsWith('message.');
export const isReactionType = (t: string): boolean => t.startsWith('reaction.');
export const hasMessageType = (types: readonly string[]): boolean => types.some(isMessageType);
export const hasReactionType = (types: readonly string[]): boolean => types.some(isReactionType);
export const hasChannelType = (types: readonly string[], catalog: readonly EventTypeInfo[]): boolean => types.some((t) => catalog.find((c) => c.type === t)?.source === 'channel');

/** A list typed as lines or commas, trimmed, without empties and duplicates. */
export function parseList(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

/** The form of an existing trigger (the secret is never known: it stays empty). */
export function formFromTrigger(t: Trigger): TriggerForm {
	const f = emptyForm();
	f.name = t.name;
	f.notes = t.notes ?? '';
	f.enabled = t.enabled;
	f.eventTypes = [...t.eventTypes];
	f.connectionIds = [...t.scope.connectionIds];
	f.chatIds = [...t.scope.chatIds];
	f.actorRoles = [...t.filters.actorRoles];
	f.actors = [...t.filters.actors];
	f.textContains = [...t.filters.textContains];
	f.textRegex = t.filters.textRegex ?? '';
	f.emoji = [...t.filters.emoji];
	f.fields = t.filters.fields.map((r) => (r.equals !== undefined ? { field: r.field, op: 'equals' as const, value: r.equals } : { field: r.field, op: 'contains' as const, value: r.contains ?? '' }));
	f.cooldownSec = String(t.cooldownSec);
	f.allowSelf = t.allowSelf;
	const a = t.action;
	f.actionKind = a.kind;
	if (a.kind === 'wake') {
		f.agentId = a.agentId;
		f.target = a.target;
		f.instruction = a.instruction;
		f.includeText = a.includeText ?? false;
	} else if (a.kind === 'program') f.programId = a.programId;
	else if (a.kind === 'notify') {
		f.notifyTitle = a.title ?? '';
		f.dm = a.dm ?? false;
	} else f.url = a.url;
	return f;
}

/** The action object of a form. */
export function actionFromForm(f: TriggerForm): TriggerAction {
	if (f.actionKind === 'wake') return { kind: 'wake', agentId: f.agentId, target: f.target, instruction: f.instruction.trim(), includeText: f.includeText };
	if (f.actionKind === 'program') return { kind: 'program', programId: f.programId };
	if (f.actionKind === 'notify') return { kind: 'notify', dm: f.dm, ...(f.notifyTitle.trim() ? { title: f.notifyTitle.trim() } : {}) };
	return { kind: 'webhook', url: f.url.trim() };
}

/** The API body of a form (create and patch take the same fields; the secret only when typed). */
export function bodyFromForm(f: TriggerForm): TriggerCreate {
	const message = hasMessageType(f.eventTypes);
	const reaction = hasReactionType(f.eventTypes);
	const fields = f.fields
		.filter((r) => r.field.trim() && r.value.trim())
		.map((r) => (r.op === 'equals' ? { field: r.field.trim(), equals: r.value.trim() } : { field: r.field.trim(), contains: r.value.trim() }));
	const body: TriggerCreate = {
		name: f.name.trim(),
		enabled: f.enabled,
		eventTypes: f.eventTypes as TriggerCreate['eventTypes'],
		scope: { connectionIds: f.connectionIds, chatIds: f.chatIds },
		filters: {
			actorRoles: f.actorRoles,
			actors: f.actors,
			textContains: message ? f.textContains : [],
			...(message && f.textRegex.trim() ? { textRegex: f.textRegex.trim() } : {}),
			emoji: reaction ? f.emoji : [],
			fields
		},
		action: actionFromForm(f),
		cooldownSec: Number(f.cooldownSec.trim() === '' ? 0 : f.cooldownSec),
		allowSelf: f.allowSelf,
		notes: f.notes.trim() === '' ? null : f.notes.trim()
	};
	if (f.actionKind === 'webhook' && f.secret.trim()) body.webhookSecret = f.secret.trim();
	return body;
}

/** The server's rule for a regex: short, valid, no back references and no nested repeats. */
export function regexError(source: string): string | undefined {
	const s = source.trim();
	if (s === '') return undefined;
	if (s.length > MAX_REGEX) return `At most ${MAX_REGEX} characters (this has ${s.length}).`;
	if (/\\[1-9]|\\k</.test(s)) return 'Back references (\\1, \\k<name>) are not allowed.';
	if (/\([^()]*[+*}][^()]*\)\s*[+*{]/.test(s)) return 'Nested repeats like (a+)+ are not allowed.';
	try {
		new RegExp(s, 'i');
	} catch {
		return 'This is not a valid regular expression.';
	}
	return undefined;
}

export const isHttpsUrl = (v: string): boolean => {
	try {
		return new URL(v.trim()).protocol === 'https:';
	} catch {
		return false;
	}
};

export type FormContext = {
	/** The trigger being edited has a stored secret. */
	hadSecret?: boolean;
	editing?: boolean;
};

/** Errors keyed by field (empty = valid). Mirrors the server so most mistakes show before the call. */
export function validateForm(f: TriggerForm, ctx: FormContext = {}): Record<string, string> {
	const e: Record<string, string> = {};
	const name = f.name.trim();
	if (!name) e.name = 'Give the trigger a name.';
	else if (name.length > MAX_NAME) e.name = `At most ${MAX_NAME} characters.`;
	if (f.eventTypes.length === 0) e.eventTypes = 'Choose at least one event type.';
	if (!hasMessageType(f.eventTypes)) {
		if (f.textContains.length > 0 || f.textRegex.trim()) e.text = 'A text filter needs a message event type. Remove the filter or choose a message type.';
	} else {
		const re = regexError(f.textRegex);
		if (re) e.textRegex = re;
	}
	if (!hasReactionType(f.eventTypes) && f.emoji.length > 0) e.emoji = 'An emoji filter needs a reaction event type.';
	if (f.fields.some((r) => (r.field.trim() === '') !== (r.value.trim() === ''))) e.fields = 'Each field filter needs a field and a value.';
	const cd = f.cooldownSec.trim() === '' ? 0 : Number(f.cooldownSec);
	if (!Number.isInteger(cd) || cd < 0) e.cooldownSec = 'A whole number of seconds, 0 or more.';
	if (f.actionKind === 'wake') {
		if (!f.agentId) e.agentId = 'Choose the agent to wake.';
		if (!f.instruction.trim()) e.instruction = 'Tell the agent what to do about the event.';
	} else if (f.actionKind === 'program') {
		if (!f.programId) e.programId = 'Choose the program to run.';
	} else if (f.actionKind === 'webhook') {
		if (!isHttpsUrl(f.url)) e.url = 'Enter an https URL.';
		const secret = f.secret.trim();
		if (secret && secret.length < MIN_SECRET) e.secret = `At least ${MIN_SECRET} characters.`;
		else if (!secret && !(ctx.editing && ctx.hadSecret)) e.secret = `A webhook needs a secret of at least ${MIN_SECRET} characters (it signs every call).`;
	}
	return e;
}

/** A random secret of 40 hex characters (the Web Crypto of the browser). */
export function generateSecret(bytes = 20): string {
	const a = new Uint8Array(bytes);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PREFILL_FIELDS = ['program', 'kind', 'status', 'state'];

/** The create form prefilled from an event: its type, connection, chat, person and, for an app event, its most telling fact. */
export function prefillFromEvent(event: StreamEvent): Partial<TriggerForm> {
	const p: Partial<TriggerForm> = { eventTypes: [event.type] };
	if (event.source === 'channel') {
		if (event.connectionId) p.connectionIds = [event.connectionId];
		const chat = event.chat?.roomId ?? event.chat?.nodeId;
		if (chat) p.chatIds = [chat];
	}
	if (event.actor?.id && !event.actor.self) p.actors = [event.actor.id];
	if (event.source === 'app') {
		const field = PREFILL_FIELDS.find((k) => (event.fields[k] ?? '') !== '');
		if (field) p.fields = [{ field, op: 'equals', value: event.fields[field] as string }];
	}
	return p;
}

export const formWithPrefill = (event: StreamEvent): TriggerForm => ({ ...emptyForm(), ...prefillFromEvent(event) });

// ---- sentences ----

const join = (items: readonly string[], word = 'or'): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export type Names = {
	typeLabel?: (type: string) => string;
	connection?: (id: string) => string;
	chat?: (id: string) => string;
	agent?: (id: string) => string;
	program?: (id: string) => string;
};

/** "Listens to: Message, Reaction added" */
export function listensText(t: Pick<Trigger, 'eventTypes'>, names: Names = {}): string {
	const label = names.typeLabel ?? ((x: string) => x);
	return `Listens to ${join(t.eventTypes.map(label), 'and')}`;
}

/** "in 2 connections, in 3 chats" or "anywhere". */
export function scopeText(t: Pick<Trigger, 'scope'>, names: Names = {}): string {
	const parts: string[] = [];
	const { connectionIds, chatIds } = t.scope;
	if (connectionIds.length) parts.push(connectionIds.length <= 2 ? `on ${join(connectionIds.map((id) => names.connection?.(id) ?? id), 'and')}` : `on ${plural(connectionIds.length, 'connection')}`);
	if (chatIds.length) parts.push(chatIds.length <= 2 && names.chat ? `in ${join(chatIds.map((id) => names.chat?.(id) ?? id), 'and')}` : `in ${plural(chatIds.length, 'chat')}`);
	return parts.length ? parts.join(', ') : 'anywhere';
}

/** The filters on one line, or an empty string when there are none. */
export function filtersText(t: Pick<Trigger, 'filters'>): string {
	const f = t.filters;
	const parts: string[] = [];
	if (f.actorRoles.length) parts.push(`by ${join(f.actorRoles)}`);
	if (f.actors.length) parts.push(`from ${join(f.actors)}`);
	if (f.textContains.length) parts.push(`text has ${join(f.textContains.map((w) => `"${w}"`))}`);
	if (f.textRegex) parts.push(`text matches /${f.textRegex}/`);
	if (f.emoji.length) parts.push(`emoji ${join(f.emoji)}`);
	for (const r of f.fields) parts.push(r.equals !== undefined ? `${r.field} is ${r.equals}` : `${r.field} contains ${r.contains ?? ''}`);
	return parts.join(', ');
}

/** What the trigger does, in a sentence. */
export function actionText(t: Pick<Trigger, 'action'>, names: Names = {}): string {
	const a = t.action;
	if (a.kind === 'wake') return `wakes ${names.agent?.(a.agentId) ?? 'an agent'}${a.target === 'chat' ? ' in the event chat' : a.target === 'thread' ? ' in its newest chat' : ' in the Triggers chat'}`;
	if (a.kind === 'program') return `runs ${names.program?.(a.programId) ?? 'a program'}`;
	if (a.kind === 'notify') return a.dm ? 'notifies you and messages you directly' : 'notifies you in the bell';
	try {
		return `calls ${new URL(a.url).host}`;
	} catch {
		return 'calls a webhook';
	}
}

/** The whole trigger in one line: "Listens to … anywhere, by admin; wakes …". */
export function summaryText(t: Trigger, names: Names = {}): string {
	const filters = filtersText(t);
	return `${listensText(t, names)} ${scopeText(t, names)}${filters ? `, ${filters}` : ''}; ${actionText(t, names)}.`;
}

/** "N non-matching messages not logged", or an empty string. */
export const filteredHint = (n: number): string => (n > 0 ? `${n.toLocaleString()} non-matching ${n === 1 ? 'message' : 'messages'} not logged since the server started` : '');

/** The header line: "3 firings in the last hour of at most 60" (cap 0 = no cap). */
export function capText(executed: number, cap: number): string {
	const n = `${plural(executed, 'firing')} in the last hour`;
	return cap > 0 ? `${n} of at most ${cap}` : `${n}, no cap`;
}

/** "Last fired 5m ago" or "Never fired". */
export const lastFiredText = (at: number | null, now: number = Date.now()): string => (at ? `Last fired ${timeAgo(at, now) === 'now' ? 'just now' : `${timeAgo(at, now)} ago`}` : 'Never fired');

/** The cooldown in the largest whole unit: "none", "30 seconds", "5 minutes", "2 hours". */
export function cooldownText(sec: number): string {
	if (!(sec > 0)) return 'none';
	if (sec % 3600 === 0) return plural(sec / 3600, 'hour');
	if (sec % 60 === 0) return plural(sec / 60, 'minute');
	return plural(sec, 'second');
}

// ---- firings ----

export type Variant = 'success' | 'secondary' | 'destructive' | 'warning';

export const fireLabel = (r: TriggerFire['result']): string => (r === 'ok' ? 'Done' : r === 'skipped' ? 'Skipped' : 'Error');
export const fireVariant = (r: TriggerFire['result']): Variant => (r === 'ok' ? 'success' : r === 'skipped' ? 'secondary' : 'destructive');

export const FIRE_RESULTS: { id: TriggerFire['result']; label: string }[] = [
	{ id: 'ok', label: 'Done' },
	{ id: 'skipped', label: 'Skipped' },
	{ id: 'error', label: 'Errors' }
];

const SKIP_REASONS: Record<string, string> = {
	cooldown: 'Fired too recently (cooldown)',
	paused: 'The app was paused',
	filtered: 'The filters did not match',
	loop: 'Caused by the agent itself',
	cap: 'The hourly cap was reached',
	busy: 'The agent was busy',
	disabled: 'The trigger was disabled'
};

/** The reason of a skipped or failed firing in words (an unknown code is shown as it is). */
export function fireReasonText(f: Pick<TriggerFire, 'result' | 'reason'>): string {
	if (f.result === 'ok' || !f.reason) return '';
	return f.result === 'skipped' ? (SKIP_REASONS[f.reason] ?? f.reason) : f.reason;
}

const DETAIL_LABELS: Record<string, string> = {
	sessionId: 'session',
	taskId: 'task',
	runId: 'run',
	status: 'HTTP status',
	attempts: 'attempts',
	error: 'error',
	notificationId: 'notification',
	programId: 'program',
	agentId: 'agent'
};

/** The facts of a firing as short `label value` pairs (only plain values; nested data is skipped). */
export function fireDetailRows(d: Record<string, unknown>): { key: string; label: string; value: string }[] {
	const out: { key: string; label: string; value: string }[] = [];
	for (const [key, v] of Object.entries(d)) {
		if (v === null || v === undefined || v === '') continue;
		if (typeof v === 'object') continue;
		out.push({ key, label: DETAIL_LABELS[key] ?? key, value: String(v) });
	}
	return out;
}

/** `Open chat` href for a session id of a web chat (`dm:<agent>` or `chat:<agent>:<thread>`), else undefined. */
export function sessionRoute(sessionId: string): string | undefined {
	const dm = /^dm:([^:]+)$/.exec(sessionId);
	if (dm) return `/a/${dm[1]}`;
	const chat = /^chat:([^:]+):[^:]+$/.exec(sessionId);
	return chat ? `/a/${chat[1]}?t=${encodeURIComponent(sessionId)}` : undefined;
}

/** "wake", "program", ... as a short phrase. */
export const actionKindLabel = (k: ActionKind): string => ACTION_KINDS.find((a) => a.id === k)?.label ?? k;

// ---- dry run ----

export const verdictLabel = (v: TriggerDryRun['verdict'], reason?: string): string => (v === 'fire' ? 'Would fire' : v === 'skip' ? `Would skip${reason ? `: ${reason}` : ''}` : `Does not match${reason ? `: ${reason}` : ''}`);
export const verdictVariant = (v: TriggerDryRun['verdict']): Variant => (v === 'fire' ? 'success' : v === 'skip' ? 'warning' : 'secondary');
export const DRY_RUN_NOTE = 'Nothing was done: this was a dry run.';
