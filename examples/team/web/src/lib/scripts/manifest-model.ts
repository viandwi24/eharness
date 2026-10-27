// The manifest as the simple editor sees it: typed, with defaults filled in, and back to clean JSON
// (empty lists and defaults left out). Pure; the server's parseManifest stays the authority.

export const CHANNEL_EVENTS = [
	{ value: 'message.created', label: 'New message', group: 'Messages' },
	{ value: 'message.edited', label: 'Message edited', group: 'Messages' },
	{ value: 'message.deleted', label: 'Message deleted', group: 'Messages' },
	{ value: 'reaction.added', label: 'Reaction added', group: 'Reactions' },
	{ value: 'reaction.removed', label: 'Reaction removed', group: 'Reactions' },
	{ value: 'reactions.updated', label: 'Reaction counts', group: 'Reactions' },
	{ value: 'member.joined', label: 'Member joined', group: 'Members' },
	{ value: 'member.left', label: 'Member left', group: 'Members' },
	{ value: 'member.updated', label: 'Member changed', group: 'Members' },
	{ value: 'member.join_requested', label: 'Join request', group: 'Members' },
	{ value: 'member.join_request_resolved', label: 'Join request answered', group: 'Members' },
	{ value: 'node.created', label: 'Chat added', group: 'Chats' },
	{ value: 'node.updated', label: 'Chat changed', group: 'Chats' },
	{ value: 'node.state_changed', label: 'Chat state changed', group: 'Chats' },
	{ value: 'node.migrated', label: 'Chat moved', group: 'Chats' },
	{ value: 'action', label: 'Button pressed', group: 'Other' }
] as const;

export const TABLE_EVENTS = [
	{ value: 'row.created', label: 'Row added' },
	{ value: 'row.updated', label: 'Row changed' },
	{ value: 'row.deleted', label: 'Row deleted' }
] as const;

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;

/** Message kinds a channel trigger can filter on (the server's MESSAGE_KINDS). */
export const MESSAGE_KINDS = [
	{ value: 'text', label: 'Text' },
	{ value: 'photo', label: 'Photo' },
	{ value: 'video', label: 'Video' },
	{ value: 'animation', label: 'GIF' },
	{ value: 'album', label: 'Album' },
	{ value: 'sticker', label: 'Sticker' },
	{ value: 'voice', label: 'Voice' },
	{ value: 'video_note', label: 'Video note' },
	{ value: 'audio', label: 'Audio' },
	{ value: 'document', label: 'File' },
	{ value: 'poll', label: 'Poll' },
	{ value: 'location', label: 'Location' },
	{ value: 'venue', label: 'Venue' },
	{ value: 'contact', label: 'Contact' },
	{ value: 'dice', label: 'Dice' }
] as const;

/** A yes/no filter that may be left open. */
export type TriState = 'any' | 'yes' | 'no';

/** What the team app does that a script may start on. */
export const APP_EVENTS = [
	{ value: 'task-changed', label: 'Task changed', group: 'Work' },
	{ value: 'program-changed', label: 'Program changed', group: 'Work' },
	{ value: 'routine-fired', label: 'Routine fired', group: 'Work' },
	{ value: 'routine-changed', label: 'Routine changed', group: 'Work' },
	{ value: 'decision-changed', label: 'Decision changed', group: 'Work' },
	{ value: 'child-reported', label: 'Helper reported', group: 'Work' },
	{ value: 'message-added', label: 'Chat message added', group: 'Agents' },
	{ value: 'agent-message', label: 'Agent-to-agent message', group: 'Agents' },
	{ value: 'turn-started', label: 'Turn started', group: 'Agents' },
	{ value: 'pending-changed', label: 'Waiting for a person', group: 'Agents' },
	{ value: 'approval-decided', label: 'Approval answered', group: 'Agents' },
	{ value: 'attention-answered', label: 'Question answered', group: 'Agents' },
	{ value: 'agent-changed', label: 'Agent changed', group: 'Agents' },
	{ value: 'heartbeat-changed', label: 'Heartbeat changed', group: 'Agents' },
	{ value: 'thread-changed', label: 'Thread changed', group: 'Agents' },
	{ value: 'file-changed', label: 'Library file changed', group: 'System' },
	{ value: 'alarm-raised', label: 'Alarm raised', group: 'System' },
	{ value: 'notification-changed', label: 'Notification', group: 'System' },
	{ value: 'settings-changed', label: 'Settings changed', group: 'System' },
	{ value: 'providers-changed', label: 'Providers changed', group: 'System' },
	{ value: 'connectors-changed', label: 'Connectors changed', group: 'System' }
] as const;

export type ChannelTrigger = {
	kind: 'channel';
	events: string[];
	connections: string[];
	chats: string[];
	actorRoles: string[];
	actors: string[];
	textContains: string[];
	textRegex: string;
	messageKinds: string[];
	isReply: TriState;
	isForward: TriState;
	forwardFrom: string[];
	hasLink: TriState;
};

/** A schedule in friendly terms; `cron` and `at` keep the raw form. */
export type Schedule =
	| { mode: 'every'; every: number; unit: 'minutes' | 'hours' | 'days' }
	| { mode: 'daily'; time: string; timezone: string }
	| { mode: 'weekly'; days: number[]; time: string; timezone: string }
	| { mode: 'cron'; expr: string; timezone: string }
	| { mode: 'at'; at: string };

export type ScheduleTrigger = { kind: 'schedule'; schedule: Schedule };
/** `where` is the filter as JSON text (what the field shows); invalid text is kept out of the manifest. */
export type TableTrigger = { kind: 'table'; table: string; events: string[]; fields: string[]; where: string; startsToMatch: boolean };
export type AppTrigger = { kind: 'app'; events: string[]; agents: string[]; match: { key: string; value: string }[] };
export type WebhookTrigger = { kind: 'webhook' };
export type Trigger = ChannelTrigger | ScheduleTrigger | TableTrigger | AppTrigger | WebhookTrigger;

export type ChatGrant = { connection: string; chat: string; topic: string };

export type Grants = {
	send: ChatGrant[];
	reply: boolean;
	libraryRead: string[];
	libraryWrite: string[];
	tablesRead: string[];
	tablesWrite: string[];
	http: string[];
	wake: string[];
	programs: string[];
	api: string[];
	read: ChatGrant[];
	moderate: ChatGrant[];
	actions: Array<{ connection: string; name: string }>;
	notify: boolean;
};

export type SimpleManifest = {
	triggers: Trigger[];
	grants: Grants;
	cooldownSec: number;
	maxRunsPerHour: number;
	/** Off: what the app sent, what the script wrote and what its own API calls caused start it too. */
	loopGuard: boolean;
	logOnly: boolean;
	limits: Record<string, number>;
};

export const DEFAULT_RUNS_PER_HOUR = 60;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A table trigger's filter text as an object, or undefined when empty or not a JSON object. */
export function whereOf(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) return undefined;
	try {
		const v = JSON.parse(text) as unknown;
		return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
const tri = (v: unknown): TriState => (v === true ? 'yes' : v === false ? 'no' : 'any');
const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt);

export const emptyGrants = (): Grants => ({ send: [], reply: false, libraryRead: [], libraryWrite: [], tablesRead: [], tablesWrite: [], http: [], wake: [], programs: [], api: [], read: [], moderate: [], actions: [], notify: false });

export const newTrigger = (kind: Trigger['kind']): Trigger =>
	kind === 'channel'
		? { kind, events: ['message.created'], connections: [], chats: [], actorRoles: [], actors: [], textContains: [], textRegex: '', messageKinds: [], isReply: 'any', isForward: 'any', forwardFrom: [], hasLink: 'any' }
		: kind === 'schedule'
			? { kind, schedule: { mode: 'daily', time: '09:00', timezone: '' } }
			: kind === 'table'
				? { kind, table: '', events: ['row.created'], fields: [], where: '', startsToMatch: false }
				: kind === 'app'
					? { kind, events: ['task-changed'], agents: [], match: [] }
					: { kind };

const pad = (n: number): string => String(n).padStart(2, '0');

/** A schedule spec of the manifest in friendly terms (cron patterns the builder makes come back as daily/weekly). */
export function scheduleFromSpec(spec: unknown): Schedule {
	const s = obj(spec);
	if (s.kind === 'every') {
		const ms = int(s.everyMs, 3_600_000);
		if (ms % 86_400_000 === 0) return { mode: 'every', every: ms / 86_400_000, unit: 'days' };
		if (ms % 3_600_000 === 0) return { mode: 'every', every: ms / 3_600_000, unit: 'hours' };
		return { mode: 'every', every: Math.max(1, Math.round(ms / 60_000)), unit: 'minutes' };
	}
	if (s.kind === 'at') return { mode: 'at', at: typeof s.at === 'number' ? new Date(s.at).toISOString() : String(s.at ?? '') };
	const expr = typeof s.expr === 'string' ? s.expr.trim() : '';
	const timezone = typeof s.timezone === 'string' ? s.timezone : typeof s.tz === 'string' ? s.tz : '';
	const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(expr);
	if (m) {
		const minute = Number(m[1]);
		const hour = Number(m[2]);
		if (minute < 60 && hour < 24) {
			const time = `${pad(hour)}:${pad(minute)}`;
			if (m[3] === '*') return { mode: 'daily', time, timezone };
			return { mode: 'weekly', days: m[3]!.split(',').map(Number), time, timezone };
		}
	}
	return { mode: 'cron', expr: expr || '0 9 * * *', timezone };
}

/** A friendly schedule as a manifest spec. */
export function specFromSchedule(s: Schedule): Record<string, unknown> {
	const tz = (t: string): Record<string, unknown> => (t.trim() ? { timezone: t.trim() } : {});
	const hm = (time: string): [number, number] => {
		const [h, m] = time.split(':').map(Number);
		return [Number.isFinite(h) ? h! : 9, Number.isFinite(m) ? m! : 0];
	};
	switch (s.mode) {
		case 'every': {
			const unitMs = s.unit === 'days' ? 86_400_000 : s.unit === 'hours' ? 3_600_000 : 60_000;
			return { kind: 'every', everyMs: Math.max(1, Math.trunc(s.every)) * unitMs };
		}
		case 'daily': {
			const [h, m] = hm(s.time);
			return { kind: 'cron', expr: `${m} ${h} * * *`, ...tz(s.timezone) };
		}
		case 'weekly': {
			const [h, m] = hm(s.time);
			const days = [...new Set(s.days)].sort((a, b) => a - b);
			return { kind: 'cron', expr: `${m} ${h} * * ${days.length ? days.join(',') : '*'}`, ...tz(s.timezone) };
		}
		case 'cron':
			return { kind: 'cron', expr: s.expr.trim(), ...tz(s.timezone) };
		case 'at':
			return { kind: 'at', at: s.at };
	}
}

/** Any manifest object (from JSON) as the simple model. Unknown fields are dropped. */
export function fromManifest(input: unknown): SimpleManifest {
	const raw = obj(input);
	const triggers: Trigger[] = [];
	for (const t of Array.isArray(raw.triggers) ? raw.triggers : []) {
		const r = obj(t);
		if (r.kind === 'channel')
			triggers.push({
				kind: 'channel',
				events: strings(r.events),
				connections: strings(r.connections),
				chats: strings(r.chats),
				actorRoles: strings(r.actorRoles),
				actors: strings(r.actors),
				textContains: strings(r.textContains),
				textRegex: typeof r.textRegex === 'string' ? r.textRegex : '',
				messageKinds: strings(r.messageKinds),
				isReply: tri(r.isReply),
				isForward: tri(r.isForward),
				forwardFrom: strings(r.forwardFrom),
				hasLink: tri(r.hasLink)
			});
		else if (r.kind === 'schedule') triggers.push({ kind: 'schedule', schedule: scheduleFromSpec(r.spec) });
		else if (r.kind === 'table')
			triggers.push({
				kind: 'table',
				table: typeof r.table === 'string' ? r.table : '',
				events: strings(r.events),
				fields: strings(r.fields),
				where: r.where !== undefined && r.where !== null ? JSON.stringify(r.where) : '',
				startsToMatch: r.startsToMatch === true
			});
		else if (r.kind === 'app')
			triggers.push({ kind: 'app', events: strings(r.events), agents: strings(r.agents), match: Object.entries(obj(r.match)).map(([key, value]) => ({ key, value: String(value) })) });
		else if (r.kind === 'webhook') triggers.push({ kind: 'webhook' });
	}
	const g = obj(raw.grants);
	const chatGrants = (v: unknown): ChatGrant[] =>
		(Array.isArray(v) ? v : []).map((x) => {
			const o = obj(x);
			return { connection: String(o.connection ?? ''), chat: String(o.chat ?? ''), topic: typeof o.topic === 'string' ? o.topic : '' };
		});
	const send = chatGrants(g.send);
	const limits: Record<string, number> = {};
	for (const [k, v] of Object.entries(obj(raw.limits))) if (typeof v === 'number') limits[k] = v;
	return {
		triggers,
		grants: {
			send,
			reply: g.reply === true,
			libraryRead: strings(g.libraryRead),
			libraryWrite: strings(g.libraryWrite),
			tablesRead: strings(g.tablesRead),
			tablesWrite: strings(g.tablesWrite),
			http: strings(g.http),
			wake: strings(g.wake),
			programs: strings(g.programs),
			api: strings(g.api),
			read: chatGrants(g.read),
			moderate: chatGrants(g.moderate),
			actions: (Array.isArray(g.actions) ? g.actions : []).map((x) => {
				const o = obj(x);
				return { connection: String(o.connection ?? ''), name: String(o.name ?? '') };
			}),
			notify: g.notify === true
		},
		cooldownSec: int(raw.cooldownSec, 0),
		maxRunsPerHour: int(raw.maxRunsPerHour, DEFAULT_RUNS_PER_HOUR),
		loopGuard: raw.loopGuard !== false,
		logOnly: raw.logOnly === true,
		limits
	};
}

const clean = (list: string[]): string[] => [...new Set(list.map((x) => x.trim()).filter(Boolean))];

/** The simple model as manifest JSON: empty lists, `false` and defaults left out. */
export function toManifest(m: SimpleManifest): Record<string, unknown> {
	const triggers = m.triggers.map((t) => {
		if (t.kind === 'channel') {
			const out: Record<string, unknown> = { kind: 'channel', events: clean(t.events) };
			for (const key of ['connections', 'chats', 'actorRoles', 'actors', 'textContains', 'messageKinds', 'forwardFrom'] as const) {
				const v = clean(t[key]);
				if (v.length) out[key] = v;
			}
			if (t.textRegex.trim()) out.textRegex = t.textRegex.trim();
			for (const key of ['isReply', 'isForward', 'hasLink'] as const) if (t[key] !== 'any') out[key] = t[key] === 'yes';
			return out;
		}
		if (t.kind === 'schedule') return { kind: 'schedule', spec: specFromSchedule(t.schedule) };
		if (t.kind === 'webhook') return { kind: 'webhook' };
		if (t.kind === 'app') {
			const out: Record<string, unknown> = { kind: 'app', events: clean(t.events) };
			const agents = clean(t.agents);
			if (agents.length) out.agents = agents;
			const match = Object.fromEntries(t.match.filter((m) => m.key.trim()).map((m) => [m.key.trim(), m.value]));
			if (Object.keys(match).length) out.match = match;
			return out;
		}
		const out: Record<string, unknown> = { kind: 'table', table: t.table.trim(), events: clean(t.events) };
		const fields = clean(t.fields);
		if (fields.length) out.fields = fields;
		const where = whereOf(t.where);
		if (where !== undefined) {
			out.where = where;
			if (t.startsToMatch) out.startsToMatch = true;
		}
		return out;
	});
	const g = m.grants;
	const grants: Record<string, unknown> = {};
	const chats = (list: ChatGrant[]) =>
		list
			.filter((s) => s.connection.trim() && s.chat.trim())
			.map((s) => ({ connection: s.connection.trim(), chat: s.chat.trim(), ...(s.topic.trim() ? { topic: s.topic.trim() } : {}) }));
	const send = chats(g.send);
	if (send.length) grants.send = send;
	if (g.reply) grants.reply = true;
	for (const key of ['libraryRead', 'libraryWrite', 'tablesRead', 'tablesWrite', 'http', 'wake', 'programs', 'api'] as const) {
		const v = clean(g[key]);
		if (v.length) grants[key] = v;
	}
	const read = chats(g.read);
	if (read.length) grants.read = read;
	const moderate = chats(g.moderate);
	if (moderate.length) grants.moderate = moderate;
	const actions = g.actions.filter((a) => a.connection.trim() && a.name.trim()).map((a) => ({ connection: a.connection.trim(), name: a.name.trim() }));
	if (actions.length) grants.actions = actions;
	if (g.notify) grants.notify = true;
	const out: Record<string, unknown> = { triggers, grants };
	if (m.cooldownSec > 0) out.cooldownSec = m.cooldownSec;
	if (m.maxRunsPerHour !== DEFAULT_RUNS_PER_HOUR) out.maxRunsPerHour = m.maxRunsPerHour;
	if (!m.loopGuard) out.loopGuard = false;
	if (m.logOnly) out.logOnly = true;
	if (Object.keys(m.limits).length) out.limits = { ...m.limits };
	return out;
}

/** Whether the simple editor shows everything a manifest says (otherwise JSON mode is safer). */
export function simpleCanShow(input: unknown): boolean {
	const back = toManifest(fromManifest(input));
	const norm = (v: unknown): string => JSON.stringify(toManifest(fromManifest(v)));
	// a manifest with fields the simple model drops would lose them on a round trip
	const raw = obj(input);
	const knownTop = new Set(['triggers', 'grants', 'cooldownSec', 'maxRunsPerHour', 'loopGuard', 'logOnly', 'limits']);
	if (Object.keys(raw).some((k) => !knownTop.has(k))) return false;
	return norm(input) === JSON.stringify(back);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One line about a trigger, for headers and lists. */
export function describeTrigger(t: Trigger): string {
	if (t.kind === 'channel') {
		const ev = t.events.map((e) => CHANNEL_EVENTS.find((x) => x.value === e)?.label ?? e);
		const parts = [ev.length ? ev.join(', ') : 'No event chosen'];
		if (t.chats.length) parts.push(`in ${t.chats.join(', ')}`);
		if (t.messageKinds.length) parts.push(`(${t.messageKinds.map((k) => MESSAGE_KINDS.find((x) => x.value === k)?.label ?? k).join(' or ')})`);
		if (t.textContains.length) parts.push(`containing ${t.textContains.map((w) => `“${w}”`).join(' or ')}`);
		if (t.isReply === 'yes') parts.push('replies only');
		if (t.isReply === 'no') parts.push('no replies');
		if (t.forwardFrom.length) parts.push(`forwarded from ${t.forwardFrom.join(', ')}`);
		else if (t.isForward === 'yes') parts.push('forwarded only');
		if (t.isForward === 'no') parts.push('not forwarded');
		if (t.hasLink === 'yes') parts.push('with a link');
		if (t.hasLink === 'no') parts.push('without links');
		if (t.actorRoles.length) parts.push(`by ${t.actorRoles.join('/')}`);
		return parts.join(' ');
	}
	if (t.kind === 'webhook') return 'A POST to the script’s secret URL';
	if (t.kind === 'app') {
		const ev = t.events.map((e) => APP_EVENTS.find((x) => x.value === e)?.label ?? e);
		const parts = [ev.join(', ') || 'No event chosen'];
		if (t.agents.length) parts.push(`of ${t.agents.join(', ')}`);
		if (t.match.length) parts.push(`where ${t.match.map((m) => `${m.key} = ${m.value}`).join(', ')}`);
		return parts.join(' ');
	}
	if (t.kind === 'table') {
		const ev = t.events.map((e) => TABLE_EVENTS.find((x) => x.value === e)?.label.toLowerCase() ?? e);
		const parts = [`${ev.join(', ') || 'No event'} in table ${t.table || '?'}`];
		if (t.fields.length) parts.push(`when ${t.fields.join(' or ')} changes`);
		if (whereOf(t.where)) parts.push(`${t.startsToMatch ? 'becoming' : 'matching'} ${t.where.trim()}`);
		return parts.join(' ');
	}
	const s = t.schedule;
	if (s.mode === 'every') return `Every ${s.every} ${s.every === 1 ? s.unit.replace(/s$/, '') : s.unit}`;
	if (s.mode === 'daily') return `Every day at ${s.time}`;
	if (s.mode === 'weekly') return `Every ${s.days.map((d) => WEEKDAYS[d]).join(', ') || 'week'} at ${s.time}`;
	if (s.mode === 'at') return `Once at ${s.at}`;
	return `Cron ${s.expr}`;
}

export { WEEKDAYS };

/** An example event for testing a script whose first trigger is not a chat message. */
export function sampleEventFor(t: Trigger | undefined): Record<string, unknown> | undefined {
	if (!t || t.kind === 'channel') return undefined;
	const at = Date.now();
	if (t.kind === 'app')
		return { type: t.events[0] ?? 'task-changed', at, agentSlug: t.agents[0] ?? 'lead', payload: Object.fromEntries(t.match.map((m) => [m.key, m.value])) };
	if (t.kind === 'webhook') return { type: 'webhook', at, method: 'POST', query: {}, headers: { 'content-type': 'application/json' }, body: { hello: 'world' } };
	if (t.kind === 'table') {
		const type = t.events[0] ?? 'row.created';
		const field = t.fields[0] ?? 'status';
		const before = type === 'row.created' ? undefined : { [field]: 'before' };
		const after = type === 'row.deleted' ? undefined : { [field]: 'after' };
		return {
			type,
			table: t.table,
			rowIds: ['row-1'],
			rows: after === undefined ? [] : [{ id: 'row-1', version: 2, data: after }],
			changes: [{ id: 'row-1', ...(before ? { before } : {}), ...(after ? { after } : {}), changed: [field] }],
			by: 'web owner'
		};
	}
	return { type: 'schedule', slot: at, firedAt: at };
}
