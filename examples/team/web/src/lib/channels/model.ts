import { isoDay } from '../time';
// The Channels page's view model (Telegram bot connections, chats, people, delivery). Pure.
import type { components } from '../api/schema';
import { stripMarkdown } from '../format';

export type ChannelConnection = components['schemas']['ChannelConnection'];
/** A place of a connection: a chat, a channel, a forum topic (a node of the tree). */
export type ChannelChat = components['schemas']['ChannelNode'];
export type ChannelLink = components['schemas']['ChannelLink'];
export type ChannelUnlinked = components['schemas']['ChannelUnlinked'];
export type ChannelMember = components['schemas']['ChannelMember'];
export type InboxConversation = components['schemas']['ChannelInboxConversation'];
export type LogMessage = components['schemas']['ChannelLogMessage'];
export type ChannelActivity = components['schemas']['ChannelActivity'];
export type ChannelPerson = components['schemas']['ChannelPerson'];
export type ChannelReminder = components['schemas']['ChannelReminder'];
export type ChannelPeopleSettings = components['schemas']['ChannelPeopleSettings'];
export type Role = ChannelPerson['role'];
export type ActivityType = ChannelActivity['type'];
export type ChannelPolicy = NonNullable<ChannelChat['policy']>;
export type ChannelPolicyBody = components['schemas']['ChannelPolicyBody'];
export type RuntimeState = ChannelConnection['runtime']['state'];
export type Wake = NonNullable<ChannelPolicy['wake']>;
export type Delivery = NonNullable<ChannelPolicy['delivery']>;
export type SessionScope = NonNullable<ChannelPolicy['sessionScope']>;

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'secondary';

export const STATE_LABEL: Record<RuntimeState, string> = {
	unbound: 'Not bound',
	disabled: 'Off',
	starting: 'Starting',
	running: 'Running',
	'needs-auth': 'Needs a new token',
	webhook: 'Webhook is set',
	error: 'Error',
	stopped: 'Stopped',
	lease: 'Another instance holds it'
};

export const stateTone = (s: RuntimeState): Tone =>
	s === 'running' ? 'success' : s === 'needs-auth' || s === 'error' ? 'destructive' : s === 'webhook' || s === 'starting' || s === 'lease' ? 'warning' : 'secondary';

/** What to do next, in one sentence (empty when nothing is needed). */
export function stateHint(c: ChannelConnection): string {
	switch (c.runtime.state) {
		case 'unbound':
			return 'No answering agent: the bot records what it sees. Choose an agent to answer direct messages and mentions.';
		case 'disabled':
			return 'The connection is switched off on the Connectors page.';
		case 'needs-auth':
			return c.runtime.message ?? 'Telegram rejected the token. Reconnect the bot with a new token.';
		case 'webhook':
			return 'This bot has a webhook, so Telegram sends nothing to polling. Remove the webhook to let this app poll.';
		case 'error':
			return c.runtime.message ?? 'The bot could not start.';
		default:
			return '';
	}
}

export const WAKE_OPTIONS: { value: Wake; label: string; hint: string }[] = [
	{ value: 'mention', label: 'When mentioned', hint: 'Answers @mentions, replies to it and commands. Other messages are context.' },
	{ value: 'always', label: 'Every message', hint: 'Reads and may answer everything. Needs admin rights or privacy mode off.' },
	{ value: 'never', label: 'Observe only', hint: 'Never answers here. Messages are stored as context (audit, news channels).' }
];
export const DELIVERY_OPTIONS: { value: Delivery; label: string; hint: string }[] = [
	{ value: 'final_text', label: 'Reply in chat', hint: 'The final answer is posted, quoting the message it answers.' },
	{ value: 'message_tool', label: 'Only when it posts', hint: 'Nothing is sent unless the agent uses the send tool (rooms with "every message", scheduled posts).' }
];

export const wakeLabel = (w: Wake): string => WAKE_OPTIONS.find((o) => o.value === w)?.label ?? w;
export const deliveryLabel = (d: Delivery): string => DELIVERY_OPTIONS.find((o) => o.value === d)?.label ?? d;

/** What the connection is in a chat (the platform's own word is the platform's business). */
export const MEMBER_LABEL: Record<string, string> = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
	none: 'Not in the chat',
	unknown: 'Unknown'
};
export const memberLabel = (s: string | undefined): string => (s === undefined ? 'Unknown' : (MEMBER_LABEL[s] ?? s));
/** What the connection is in a chat, named: `Telegram bot "Acme" · Admin in this chat`. */
export function connectionText(label: string, member: string | undefined): string {
	if (member === undefined) return label;
	return member === 'none' ? `${label} · not in this chat` : `${label} · ${memberLabel(member)} in this chat`;
}

/** The hint under the wake setting: of what is selected in the form, or of what is in force when the form inherits. */
export const wakeHint = (selected: Wake | '', effective: Wake): string => WAKE_OPTIONS.find((o) => o.value === (selected === '' ? effective : selected))?.hint ?? '';

/** The quiet hours in force on a node (inherited or its own), as `23:00 to 06:30`; undefined when none. */
export const quietText = (q: { from: string; to: string } | undefined): string | undefined => (q === undefined ? undefined : `${q.from} to ${q.to}`);

/** The connection is not in the chat any more (it cannot read or post). */
export const botGone = (c: ChannelChat): boolean => c.state === 'left' || c.member === 'none';
/** The connection can administer the chat (sees everything in it under privacy mode). */
export const isAdmin = (c: ChannelChat): boolean => c.member === 'admin' || c.member === 'owner';

/** A setting that is inherited by default: '' = inherit, otherwise set on this node. */
export type Inherit<T extends string> = '' | T;
export type Tri = Inherit<'on' | 'off'>;

/** The form of one node's own settings as typed. Everything starts as what the node itself sets; '' = inherit. */
export interface PolicyForm {
	allowed: Tri;
	wake: Inherit<Wake>;
	delivery: Inherit<Delivery>;
	/** Days, as typed; empty = inherit. A number input bound by Svelte holds a number (or null when empty). */
	retention: string | number | null;
	observe: Tri;
	sessionScope: Inherit<SessionScope>;
	redactOnDelete: Tri;
	/** Proactive posts (what the agent says unasked): allowed, quiet hours, digest, mention limit. */
	proactive: Tri;
	quietFrom: string;
	quietTo: string;
	digest: Tri;
	maxMentions: string | number | null;
	/** Trusted internal group: unknown people here are members (`member`) or guests (`guest`); '' = inherit. */
	defaultRole: Inherit<'member' | 'guest'>;
	/** Reply length in a group when the agent persona says nothing; '' = inherit. */
	replyStyle: Inherit<'brief' | 'normal' | 'detailed'>;
	/** Tone, language and length of this place for the agent persona (max 1000 characters); '' = inherit. */
	personaOverlay: string;
	/** A feed for its agent (every message is input, nothing is answered); '' = inherit. */
	feed: Tri;
	/** Copies from here are only recorded (trial); '' = inherit. */
	copyTrial: Tri;
}

/** The longest overlay the server accepts. */
export const MAX_OVERLAY = 1000;

/** A form field as trimmed text: a text input holds a string, a number input a number or null. */
export const fieldText = (v: string | number | null | undefined): string => String(v ?? '').trim();

const triOf = (v: boolean | undefined): Tri => (v === undefined ? '' : v ? 'on' : 'off');
const boolOf = (t: Tri): boolean | null => (t === '' ? null : t === 'on');

export const formOfChat = (c: ChannelChat): PolicyForm => ({
	// `enabled` reads as true in a policy that only sets other fields: it is the node's own only when it says so
	allowed: c.inherited.enabled?.from === 'node' ? triOf(c.policy?.enabled) : '',
	wake: c.policy?.wake ?? '',
	delivery: c.policy?.delivery ?? '',
	retention: c.policy?.retentionDays === undefined ? '' : String(c.policy.retentionDays),
	observe: triOf(c.policy?.observe),
	sessionScope: c.policy?.sessionScope ?? '',
	redactOnDelete: triOf(c.policy?.redactOnDelete),
	proactive: triOf(c.policy?.proactive?.allowed),
	quietFrom: c.policy?.proactive?.quietHours?.from ?? '',
	quietTo: c.policy?.proactive?.quietHours?.to ?? '',
	digest: triOf(c.policy?.proactive?.digest),
	maxMentions: c.policy?.proactive?.maxMentions === undefined ? '' : String(c.policy.proactive.maxMentions),
	defaultRole: c.policy?.defaultRole ?? '',
	replyStyle: c.policy?.replyStyle ?? '',
	personaOverlay: c.policy?.personaOverlay ?? '',
	feed: triOf(c.policy?.feed),
	copyTrial: triOf(c.policy?.copyTrial)
});

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A problem with the quiet hours or the mention limit as typed, or undefined. */
export function proactiveError(f: Pick<PolicyForm, 'quietFrom' | 'quietTo' | 'maxMentions'>): string | undefined {
	const from = f.quietFrom.trim();
	const to = f.quietTo.trim();
	if ((from === '') !== (to === '')) return 'Quiet hours need both a start and an end';
	if (from !== '' && (!CLOCK.test(from) || !CLOCK.test(to))) return 'Quiet hours are HH:MM (24 hours)';
	const m = fieldText(f.maxMentions);
	if (m !== '' && !(Number.isInteger(Number(m)) && Number(m) >= 0 && Number(m) <= 20)) return 'Mention limit: 0 to 20';
	return undefined;
}

export function retentionError(value: string | number | null): string | undefined {
	const text = fieldText(value);
	if (text === '') return undefined;
	const n = Number(text);
	return Number.isInteger(n) && n >= 1 && n <= 3650 ? undefined : 'Whole days, 1 to 3650';
}

/** The body of the PATCH for a form (every field explicit: `null` clears a setting so it inherits again). */
export function policyBody(f: PolicyForm): ChannelPolicyBody {
	return {
		enabled: boolOf(f.allowed),
		wake: f.wake === '' ? null : f.wake,
		delivery: f.delivery === '' ? null : f.delivery,
		retentionDays: fieldText(f.retention) === '' ? null : Number(fieldText(f.retention)),
		observe: boolOf(f.observe),
		sessionScope: f.sessionScope === '' ? null : f.sessionScope,
		redactOnDelete: boolOf(f.redactOnDelete),
		proactive: proactiveBody(f),
		defaultRole: f.defaultRole === '' ? null : f.defaultRole,
		replyStyle: f.replyStyle === '' ? null : f.replyStyle,
		personaOverlay: f.personaOverlay.trim() === '' ? null : f.personaOverlay.trim(),
		feed: boolOf(f.feed),
		copyTrial: boolOf(f.copyTrial)
	};
}

/** The proactive object of a form: only what is set; null when nothing is (inherit again). */
export function proactiveBody(f: PolicyForm): ChannelPolicyBody['proactive'] {
	const allowed = boolOf(f.proactive);
	const digest = boolOf(f.digest);
	const quiet = f.quietFrom.trim() !== '' && f.quietTo.trim() !== '' ? { from: f.quietFrom.trim(), to: f.quietTo.trim() } : undefined;
	const max = fieldText(f.maxMentions) === '' ? undefined : Number(fieldText(f.maxMentions));
	if (allowed === null && digest === null && quiet === undefined && max === undefined) return null;
	return {
		...(allowed === null ? {} : { allowed }),
		...(digest === null ? {} : { digest }),
		...(quiet === undefined ? {} : { quietHours: quiet }),
		...(max === undefined ? {} : { maxMentions: max })
	};
}

export const formChanged = (a: PolicyForm, b: PolicyForm): boolean =>
	a.allowed !== b.allowed ||
	a.wake !== b.wake ||
	a.delivery !== b.delivery ||
	fieldText(a.retention) !== fieldText(b.retention) ||
	a.observe !== b.observe ||
	a.sessionScope !== b.sessionScope ||
	a.redactOnDelete !== b.redactOnDelete ||
	a.proactive !== b.proactive ||
	a.quietFrom.trim() !== b.quietFrom.trim() ||
	a.quietTo.trim() !== b.quietTo.trim() ||
	a.digest !== b.digest ||
	a.defaultRole !== b.defaultRole ||
	a.replyStyle !== b.replyStyle ||
	a.personaOverlay.trim() !== b.personaOverlay.trim() ||
	a.feed !== b.feed ||
	a.copyTrial !== b.copyTrial ||
	fieldText(a.maxMentions) !== fieldText(b.maxMentions);

/** Where one effective setting comes from, in words ("set here", "inherited from Company"). */
export function originText(c: ChannelChat, key: keyof ChannelChat['inherited'], titleOf: (nodeId: string) => string): string {
	const o = c.inherited[key];
	if (o === undefined || o.from === 'default') return 'default';
	if (o.from === 'connection') return 'connection default';
	if (o.from === 'node') return 'set here';
	return `inherited from ${o.nodeId === undefined ? 'above' : titleOf(o.nodeId)}`;
}

export const KIND_LABEL: Record<ChannelChat['chatKind'], string> = { dm: 'Direct', group: 'Group', channel: 'Channel' };

/**
 * A warning when the bot cannot see what the policies ask of it: privacy mode hides ordinary
 * messages in groups, so "every message" and "observe only" need an admin bot (or privacy off).
 */
export function privacyWarning(c: ChannelConnection, chats: readonly ChannelChat[]): string | undefined {
	if (c.bot === undefined || c.bot.canReadAllGroupMessages) return undefined;
	const needsAll = chats.filter((x) => x.chatKind !== 'channel' && x.postable && x.effective.allowed && x.effective.wake !== 'mention' && !isAdmin(x));
	if (needsAll.length === 0) return undefined;
	const names = needsAll.slice(0, 3).map((x) => x.title).join(', ');
	return `Privacy mode is on and the bot is not an admin in ${names}${needsAll.length > 3 ? ' and others' : ''}: it only sees mentions, replies and commands there. Make it an admin, or turn privacy mode off in @BotFather (/setprivacy) and re-add the bot.`;
}

/** Posting needs rights in channels and in groups that restrict messages. */
export const cannotPost = (c: ChannelChat): boolean => c.canPost === false;

export function outboxSummary(c: ChannelConnection): string {
	const { outboxPending: p, outboxFailed: f, outboxHeld: h } = c.counts;
	const parts = [p === 0 ? 'Nothing waiting' : `${p} waiting to send`];
	if (h > 0) parts.push(`${HELD_LABEL}: ${h}`);
	if (f > 0) parts.push(`${f} failed`);
	return parts.join(' · ');
}

export const HELD_LABEL = 'Held after a restart';
/** What "held" means, for the tooltip and help text next to the count. */
export const HELD_HELP = 'The server stopped while sending these. It checks the chat and settles them automatically; nothing is sent twice.';

export type OutboxAttention = components['schemas']['ChannelOutboxAttention'];

/** The reason a message needs a look, in plain words. */
export function attentionReason(item: Pick<OutboxAttention, 'status' | 'uncertain' | 'reason' | 'kind'>): string {
	if (item.status === 'held') return 'The server stopped while sending this. It is checking the chat and will settle it by itself.';
	if (item.uncertain) return 'The server stopped while this was being sent, and the chat could not confirm whether it arrived. It was not sent again, to avoid a duplicate.';
	if (item.reason?.startsWith('interrupted before it was sent')) return 'An action of the agent was interrupted before it was sent. It is never run twice.';
	const why = item.reason?.trim();
	return why ? `Could not be sent: ${why}` : 'Could not be sent.';
}

/** What the message was, for a small label. */
export function attentionKind(kind: OutboxAttention['kind']): string {
	return kind === 'approval' ? 'Approval request' : kind === 'reminder' ? 'Reminder' : kind === 'post' ? 'Post' : 'Reply';
}

/** The warning of the "Send again" confirmation. */
export const RETRY_WARNING = 'If the first attempt did arrive, the chat will show this message twice.';

/** The count shown on the section heading: the loaded rows, with a plus when more pages exist. */
export function needsALookCount(loaded: number, more: boolean): string {
	return `${loaded}${more ? '+' : ''}`;
}

export function breakerText(c: ChannelConnection, now: number): string | undefined {
	if (c.breaker === undefined || !c.breaker.open) return undefined;
	const mins = Math.max(1, Math.ceil((c.breaker.until - now) / 60_000));
	return `Sending is paused after errors (${c.breaker.reason}). It retries in about ${mins} min, or close it now once the cause is fixed.`;
}

/** The agents a binding may choose (not archived). */
export const agentChoices = <A extends { id: string; name: string; archivedAt?: number | null }>(agents: readonly A[]): A[] => agents.filter((a) => !a.archivedAt);

/** Bound connections first, running ones before the rest. */
export function sortConnections(list: readonly ChannelConnection[]): ChannelConnection[] {
	const rank = (c: ChannelConnection): number => (c.runtime.state === 'running' ? 0 : c.binding ? 1 : 2);
	return [...list].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

// ---- channel types (the picker) and the account card ----

type Catalog = { id: string; name: string; description: string; category: string; icon?: string | undefined };

/** The connectors that are channel types (category `channels`), in the order the catalog lists them. */
export const channelTypes = <C extends Catalog>(connectors: readonly C[]): C[] => connectors.filter((c) => c.category === 'channels');

/** The type of a connection: a bot (Bot API) or a user account (MTProto). */
export const isAccount = (c: ChannelConnection): boolean => c.transport === 'user';
export const typeLabel = (c: ChannelConnection): string => (isAccount(c) ? 'Telegram account' : 'Telegram bot');

export type ChannelAccount = NonNullable<ChannelConnection['account']>;
export type AccountLimits = ChannelAccount['limits'];

export const TERMS_URL = 'https://core.telegram.org/api/terms';
export const API_ID_URL = 'https://core.telegram.org/api/obtaining_api_id';
export const ACCOUNT_WARNING =
	'Use a dedicated account, never a personal one, and turn on two-step verification. Telegram may limit or ban accounts driven by API clients, especially for spam or flooding: this app sends slowly and keeps daily caps, but the risk is yours. This is not legal advice; read the API terms.';

export const stateLabel = (s: RuntimeState): string => STATE_LABEL[s];

export const BACKFILL_STATE_LABEL: Record<string, string> = {
	idle: 'Not started',
	queued: 'Waiting',
	running: 'Reading history',
	parked: 'Paused by Telegram (flood wait)',
	done: 'Done',
	error: 'Error'
};

/** One line of backfill progress for a chosen chat. */
export function backfillText(c: ChannelChat, now: number): string {
	const b = c.account?.backfill;
	if (!b || b.days === null) return 'No history is read.';
	const parts = [`${b.days} day${b.days === 1 ? '' : 's'}`, BACKFILL_STATE_LABEL[b.state] ?? b.state, `${b.count} messages`];
	if (b.oldestAt !== undefined) parts.push(`back to ${isoDay(b.oldestAt)}`);
	if (b.state === 'parked' && b.parkedUntil !== undefined) parts.push(`resumes in about ${Math.max(1, Math.ceil((b.parkedUntil - now) / 60_000))} min`);
	if (b.error) parts.push(b.error);
	return parts.join(' · ');
}

export const lastWindowDays = (value: string | number | null | undefined): number | null | undefined => {
	const text = fieldText(value);
	if (text === '') return null;
	const n = Number(text);
	return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : undefined;
};

/** The limits form as typed (numbers as strings) and its PATCH body; undefined fields are left out. */
export interface LimitsForm {
	dmDailyMax: string | number | null;
	dailyMax: string | number | null;
	adminLogHours: string | number | null;
}
export const limitsFormOf = (l: AccountLimits): LimitsForm => ({
	dmDailyMax: String(l.dmDailyMax),
	dailyMax: String(l.dailyMax),
	adminLogHours: String(Math.round(l.adminLogEveryMs / 360_000) / 10)
});
export function limitsBody(f: LimitsForm): { body: { dmDailyMax: number; dailyMax: number; adminLogEveryMs: number } } | { error: string } {
	const int = (value: string | number | null, max: number): number | undefined => {
		const t = fieldText(value);
		const n = Number(t);
		return t !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
	};
	const dm = int(f.dmDailyMax, 1000);
	const all = int(f.dailyMax, 5000);
	const hours = Number(fieldText(f.adminLogHours));
	if (dm === undefined) return { error: 'Direct messages a day: a whole number, 0 to 1000 (0 = none)' };
	if (all === undefined) return { error: 'Messages a day: a whole number, 0 to 5000 (0 = none)' };
	if (!(hours >= 1 / 60) || fieldText(f.adminLogHours) === '') return { error: 'Admin log interval: hours, at least 1 minute' };
	return { body: { dmDailyMax: dm, dailyMax: all, adminLogEveryMs: Math.round(hours * 3_600_000) } };
}

/** Today's sends against the caps. */
export const usageText = (a: ChannelAccount): string =>
	`Today: ${a.today.dm}/${a.limits.dmDailyMax} direct messages · ${a.today.all}/${a.limits.dailyMax} in all`;

/** What the lease / auth state means, in a sentence. */
export function accountHint(c: ChannelConnection): string {
	switch (c.runtime.state) {
		case 'lease':
			return c.runtime.message ?? 'Another instance of this app is using the session. Two clients on one session would end it, so this one waits.';
		case 'needs-auth':
			return c.runtime.message ?? 'Telegram ended the session (revoked, or logged out elsewhere). Sign in again.';
		case 'error':
			return c.runtime.message ?? 'The account could not start.';
		case 'unbound':
			return 'No answering agent: the account records the chats you choose. Choose an agent to answer direct messages and mentions.';
		default:
			return '';
	}
}

// ---- people: linking without links ----

/** A Telegram user id is a whole number; undefined = valid. */
export function peerIdError(text: string): string | undefined {
	return /^\d{1,20}$/.test(text.trim()) ? undefined : 'A Telegram user id is a number, for example 123456789';
}

/** A short "5 min ago" for activity lists (falls back to a date after a week). */
export function ago(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 45) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	return d <= 7 ? `${d} day${d === 1 ? '' : 's'} ago` : isoDay(at);
}

// ---- inbox ----

/** Counters of a conversation as one line: what woke the agent, what was only read, what was dropped. */
export function inboxCounts(c: InboxConversation): string {
	const parts = [`${c.woke} woke the agent`, `${c.observed} observed`];
	if (c.dropped > 0) parts.push(`${c.dropped} dropped`);
	return parts.join(' · ');
}

/** The one-line preview of the last message ("Ana: hello", "Agent: done"). */
export function previewLine(c: InboxConversation): string {
	const p = c.preview;
	if (p === undefined) return 'Nothing stored';
	const who = p.self ? 'Agent' : p.sender;
	// the agent writes markdown: a one-line preview shows it as plain text
	const text = p.self ? stripMarkdown(p.text) : p.text;
	return who === undefined ? text : `${who}: ${text}`;
}

export const allowlistLabel = (c: Pick<InboxConversation, 'allowed' | 'kind'>): string =>
	c.allowed ? 'Allowed' : c.kind === 'dm' ? 'Not linked' : 'Not allowed';

/** Marks on one logged message (incoming kind, edits, deletions, approvals). */
export function messageMarks(m: LogMessage): string[] {
	const marks: string[] = [];
	if (m.approval) marks.push(m.approval.kind === 'question' ? 'Question' : 'Approval request');
	else if (m.self) marks.push('Agent');
	else if (m.disposition === 'woke') marks.push('Woke the agent');
	else if (m.disposition === 'observed') marks.push('Observed');
	if (m.editedAt !== undefined) marks.push('Edited');
	if (m.deletedAt !== undefined) marks.push('Deleted');
	return marks;
}

/** How an approval request ended, in words. */
export function approvalOutcome(a: NonNullable<LogMessage['approval']>): string {
	if (a.status === 'open') return 'Waiting for an answer';
	if (a.outcome === 'approved' || a.outcome === 'denied') return `${a.outcome === 'approved' ? 'Approved' : 'Denied'}${a.answeredBy ? ` by ${a.answeredBy}` : ''}`;
	return 'Answered in the web app';
}

export const messageSender = (m: LogMessage): string => (m.self ? 'Agent' : (m.senderName ?? (m.senderId ? `Telegram ${m.senderId}` : 'Unknown')));

/** The link to the agent's own thread of a conversation (undefined before it ever woke the agent). */
export const threadHref = (c: Pick<InboxConversation, 'agentId' | 'threadId'>): string | undefined =>
	c.threadId === undefined || c.agentId === '' ? undefined : `/a/${c.agentId}?t=${encodeURIComponent(c.threadId)}`;

// ---- activity ----

export const EVENT_LABEL: Record<ActivityType, string> = {
	woke: 'Woke the agent',
	observed: 'Observed',
	dropped: 'Dropped',
	'reply-queued': 'Reply queued',
	'reply-sent': 'Reply sent',
	'reply-retried': 'Retrying',
	'reply-failed': 'Failed to send',
	'approval-posted': 'Approval asked',
	'approval-answered': 'Approval answered',
	'breaker-opened': 'Sending paused',
	'needs-auth': 'Needs sign-in',
	action: 'Action',
	read: 'Read',
	parked: 'Rate limited'
};

/** Which way an event goes: received from the platform, done by the agent, or about the connection. */
export const DIRECTION_LABEL: Record<NonNullable<ChannelActivity['direction']>, string> = { in: 'In', out: 'Out', system: 'System' };
export const DIRECTION_FILTERS = [
	{ value: 'in', label: 'Received (in)' },
	{ value: 'out', label: 'Done by the agent (out)' }
] as const;

/** What an action or read did, in the past tense, and the word that joins it to the place. */
const ACTION_VERB: Record<string, [string, string]> = {
	edit: ['edited a message', 'in'],
	delete: ['deleted a message', 'in'],
	pin: ['pinned a message', 'in'],
	unpin: ['unpinned a message', 'in'],
	pin_message: ['pinned a message', 'in'],
	unpin_message: ['unpinned a message', 'in'],
	react: ['reacted to a message', 'in'],
	history: ['read the history of', ''],
	members: ['listed the members of', ''],
	download: ['downloaded an attachment from', ''],
	messages: ['read messages of', ''],
	node_info: ['looked up', ''],
	identity_info: ['looked up a person', ''],
	list_nodes: ['listed the chats', ''],
	resolve_identifier: ['looked up a person', ''],
	get_chat: ['looked up', ''],
	get_member_count: ['counted the members of', ''],
	list_admins: ['listed the admins of', ''],
	get_member: ['looked up a member of', ''],
	send_poll: ['posted a poll in', ''],
	ban_member: ['banned a member from', ''],
	unban_member: ['unbanned a member of', ''],
	promote_member: ['made a member an admin of', ''],
	demote_member: ['removed the admin rights of a member of', ''],
	admin_log: ['read the admin log of', ''],
	create_forum_topic: ['created a topic in', ''],
	// Telegram user account: reads and lookups
	list_dialogs: ['listed the dialogs of the account', ''],
	list_chats: ['listed the chats of the account', ''],
	get_user: ['looked up a person', ''],
	list_members: ['listed the members of', ''],
	list_forum_topics: ['listed the topics of', ''],
	search_messages: ['searched the messages of', ''],
	get_message: ['read a message of', ''],
	list_scheduled: ['listed the scheduled messages of', ''],
	list_join_requests: ['listed the join requests of', ''],
	list_invite_links: ['listed the invite links of', ''],
	list_contacts: ['listed the contacts of the account', ''],
	member_info: ['looked up a member of', ''],
	poll_results: ['read the poll results in', ''],
	post_stats: ['read the post statistics of', ''],
	resolve_chat: ['looked up a chat', ''],
	check_invite_link: ['checked an invite link', ''],
	chat_stats: ['read the statistics of', ''],
	// Telegram user account: chats and messages
	choose_chat: ['chose to read', ''],
	backfill: ['backfilled the history of', ''],
	forward_message: ['forwarded a message to', ''],
	schedule_message: ['scheduled a message in', ''],
	cancel_scheduled: ['cancelled a scheduled message in', ''],
	edit_forum_topic: ['edited a topic in', ''],
	restrict_member: ['restricted a member of', ''],
	delete_member_messages: ['deleted the messages of a member in', ''],
	create_invite_link: ['created an invite link for', ''],
	join_chat: ['joined', ''],
	leave_chat: ['left', ''],
	create_group: ['created a group', ''],
	create_channel: ['created a channel', ''],
	add_members: ['added members to', ''],
	set_chat_info: ['changed the title, description or photo of', ''],
	set_chat_visibility: ['changed who can find and join', ''],
	set_default_permissions: ['changed the default permissions of', ''],
	manage_chat_settings: ['changed a setting of', ''],
	answer_join_request: ['answered a join request of', ''],
	edit_invite_link: ['edited an invite link of', ''],
	revoke_invite_link: ['revoked an invite link of', ''],
	delete_chat: ['deleted or left', ''],
	transfer_ownership: ['transferred the ownership of', ''],
	add_contact: ['added a contact', ''],
	manage_topic: ['changed a topic of', ''],
	delete_forum_topic: ['deleted a topic of', ''],
	kick_member: ['removed a member from', ''],
	mark_read: ['marked as read', ''],
	clear_history: ['cleared the history of', ''],
	stop_poll: ['stopped a poll in', ''],
	copy_message: ['copied a message to', ''],
	comment_on_post: ['commented on a post of', ''],
	send_album: ['sent an album to', ''],
	manage_dialog: ['changed the dialog of', ''],
	// Telegram bot: one tool per area, the sub-action is in the parameters
	chat_info: ['read information about', ''],
	join_requests: ['handled join requests of', ''],
	chat_messages: ['managed messages in', ''],
	chat_topics: ['managed topics of', ''],
	chat_settings: ['changed settings of', ''],
	chat_members: ['managed members of', ''],
	chat_invites: ['managed invite links of', ''],
	bot_profile: ['changed the profile of the bot', ''],
	chat_destructive: ['ran a destructive action in', '']
};

/** Short label of a platform tool, for tables and filters ("Ban member"). */
export const ACTION_LABEL: Record<string, string> = {
	edit: 'Edit message',
	delete: 'Delete message',
	pin: 'Pin message',
	unpin: 'Unpin message',
	pin_message: 'Pin message',
	unpin_message: 'Unpin message',
	react: 'React',
	history: 'Read history',
	members: 'List members',
	download: 'Download attachment',
	messages: 'Read messages',
	node_info: 'Look up chat',
	identity_info: 'Look up person',
	list_nodes: 'List chats',
	resolve_identifier: 'Look up person',
	get_chat: 'Look up chat',
	get_member_count: 'Count members',
	list_admins: 'List admins',
	get_member: 'Look up member',
	send_poll: 'Send poll',
	ban_member: 'Ban member',
	unban_member: 'Unban member',
	promote_member: 'Promote to admin',
	demote_member: 'Remove admin rights',
	admin_log: 'Read admin log',
	create_forum_topic: 'Create topic',
	list_dialogs: 'List dialogs',
	list_chats: 'List chats',
	get_user: 'Look up user',
	list_members: 'List members',
	list_forum_topics: 'List topics',
	search_messages: 'Search messages',
	get_message: 'Read message',
	list_scheduled: 'List scheduled messages',
	list_join_requests: 'List join requests',
	list_invite_links: 'List invite links',
	list_contacts: 'List contacts',
	member_info: 'Look up member',
	poll_results: 'Poll results',
	post_stats: 'Post statistics',
	resolve_chat: 'Look up chat',
	check_invite_link: 'Check invite link',
	chat_stats: 'Chat statistics',
	choose_chat: 'Choose chat to read',
	backfill: 'Backfill history',
	forward_message: 'Forward message',
	schedule_message: 'Schedule message',
	cancel_scheduled: 'Cancel scheduled message',
	edit_forum_topic: 'Edit topic',
	restrict_member: 'Restrict member',
	delete_member_messages: 'Delete member messages',
	create_invite_link: 'Create invite link',
	join_chat: 'Join chat',
	leave_chat: 'Leave chat',
	create_group: 'Create group',
	create_channel: 'Create channel',
	add_members: 'Add members',
	set_chat_info: 'Change chat info',
	set_chat_visibility: 'Change chat visibility',
	set_default_permissions: 'Change default permissions',
	manage_chat_settings: 'Chat setting',
	answer_join_request: 'Answer join request',
	edit_invite_link: 'Edit invite link',
	revoke_invite_link: 'Revoke invite link',
	delete_chat: 'Delete or leave chat',
	transfer_ownership: 'Transfer ownership',
	add_contact: 'Add contact',
	manage_topic: 'Manage topic',
	delete_forum_topic: 'Delete topic',
	kick_member: 'Remove member',
	mark_read: 'Mark as read',
	clear_history: 'Clear history',
	stop_poll: 'Stop poll',
	copy_message: 'Copy message',
	comment_on_post: 'Comment on post',
	send_album: 'Send album',
	manage_dialog: 'Manage dialog',
	chat_info: 'Chat info',
	join_requests: 'Join requests',
	chat_messages: 'Messages',
	chat_topics: 'Topics',
	chat_settings: 'Chat settings',
	chat_members: 'Members',
	chat_invites: 'Invite links',
	bot_profile: 'Bot profile',
	chat_destructive: 'Destructive chat action'
};

/** What a `action=<sub>` of a tool does ("chat_members.ban" is "Ban member"). Unlisted ones are shown humanized. */
export const SUB_ACTION_LABEL: Record<string, string> = {
	'chat_info.chat': 'Chat info',
	'chat_info.member_count': 'Member count',
	'chat_info.administrators': 'List administrators',
	'chat_info.member': 'Look up member',
	'chat_info.limits': 'Bot limits',
	'join_requests.list': 'List join requests',
	'join_requests.approve': 'Approve join request',
	'join_requests.decline': 'Decline join request',
	'chat_messages.pin': 'Pin message',
	'chat_messages.unpin': 'Unpin message',
	'chat_messages.unpin_all': 'Unpin all messages',
	'chat_messages.send_poll': 'Send poll',
	'chat_messages.stop_poll': 'Stop poll',
	'chat_messages.copy': 'Copy message',
	'chat_messages.forward': 'Forward message',
	'chat_messages.send_album': 'Send album',
	'chat_topics.create': 'Create topic',
	'chat_topics.edit': 'Edit topic',
	'chat_topics.close': 'Close topic',
	'chat_topics.reopen': 'Reopen topic',
	'chat_topics.unpin_all': 'Unpin all in topic',
	'chat_topics.general_rename': 'Rename General topic',
	'chat_topics.general_close': 'Close General topic',
	'chat_topics.general_reopen': 'Reopen General topic',
	'chat_topics.general_hide': 'Hide General topic',
	'chat_topics.general_unhide': 'Show General topic',
	'chat_settings.set_title': 'Change title',
	'chat_settings.set_description': 'Change description',
	'chat_settings.delete_photo': 'Delete chat photo',
	'chat_settings.set_permissions': 'Change default permissions',
	'chat_settings.set_sticker_set': 'Set sticker set',
	'chat_settings.delete_sticker_set': 'Delete sticker set',
	'chat_settings.set_photo': 'Change chat photo',
	'chat_settings.slow_mode': 'Change slow mode',
	'chat_settings.signatures': 'Change signatures',
	'chat_settings.discussion_group': 'Change discussion group',
	'chat_settings.create_chat': 'Create chat',
	'chat_members.ban': 'Ban member',
	'chat_members.unban': 'Unban member',
	'chat_members.kick': 'Remove member',
	'chat_members.restrict': 'Restrict member',
	'chat_members.promote': 'Promote to admin',
	'chat_members.edit_admin': 'Change admin rights',
	'chat_members.demote': 'Remove admin rights',
	'chat_members.admin_title': 'Change admin title',
	'chat_members.ban_sender_chat': 'Ban a channel',
	'chat_members.unban_sender_chat': 'Unban a channel',
	'chat_members.add_member': 'Add member',
	'chat_invites.export_link': 'Export invite link',
	'chat_invites.create_link': 'Create invite link',
	'chat_invites.edit_link': 'Edit invite link',
	'chat_invites.revoke_link': 'Revoke invite link',
	'bot_profile.set_commands': 'Change bot commands',
	'bot_profile.set_description': 'Change bot description',
	'bot_profile.set_name': 'Change bot name',
	'chat_destructive.delete_topic': 'Delete topic',
	'chat_destructive.delete_messages': 'Delete messages',
	'chat_destructive.leave_chat': 'Leave chat',
	'manage_chat_settings.auto_delete': 'Auto-delete timer',
	'manage_chat_settings.protected_content': 'Protected content',
	'manage_chat_settings.hide_members': 'Hide members',
	'manage_chat_settings.history_visible': 'History for new members',
	'manage_chat_settings.reactions': 'Allowed reactions',
	'manage_chat_settings.signatures': 'Post signatures',
	'manage_chat_settings.link_discussion': 'Link discussion group',
	'manage_chat_settings.unlink_discussion': 'Unlink discussion group',
	'manage_chat_settings.default_send_as': 'Default send-as',
	'answer_join_request.approve': 'Approve join request',
	'answer_join_request.decline': 'Decline join request',
	'manage_topic.pin': 'Pin topic',
	'manage_topic.unpin': 'Unpin topic',
	'manage_topic.hide_general': 'Hide General topic',
	'manage_topic.show_general': 'Show General topic',
	'pin_message.pin': 'Pin message',
	'pin_message.unpin': 'Unpin message',
	'pin_message.unpin_all': 'Unpin all messages',
	'manage_dialog.mute': 'Mute chat',
	'manage_dialog.unmute': 'Unmute chat',
	'manage_dialog.archive': 'Archive chat',
	'manage_dialog.unarchive': 'Unarchive chat',
	'manage_dialog.pin': 'Pin chat',
	'manage_dialog.unpin': 'Unpin chat'
};

/** The sub-action (`action=ban`) an audit summary carries, when the tool has one. */
export const subActionOf = (summary: string | undefined): string | undefined => (summary === undefined ? undefined : /(?:^|\s)action=([a-z_]+)/.exec(summary)?.[1]);

/** "Ban member" for a tool, or the sub-action's label for a tool that has areas ("Chat members: ban" falls back to "Members · ban"). */
export function actionLabel(action: string, summary?: string): string {
	const sub = subActionOf(summary);
	if (sub !== undefined) {
		const own = SUB_ACTION_LABEL[`${action}.${sub}`];
		if (own !== undefined) return own;
		return `${ACTION_LABEL[action] ?? humanizeName(action)} · ${sub.replace(/[_-]+/g, ' ')}`;
	}
	return ACTION_LABEL[action] ?? humanizeName(action);
}

const humanizeName = (name: string): string => {
	const t = name.replace(/[_-]+/g, ' ').trim();
	return t === '' ? 'Action' : t.charAt(0).toUpperCase() + t.slice(1);
};

const humanize = (name: string): string => name.replace(/[_-]+/g, ' ');

/** "pinned a message in TEAMKU / produksi, requested by Vian" (an `action` or `read` event). */
export function actionText(e: ChannelActivity): string {
	const [verb, prep] = ACTION_VERB[e.action ?? ''] ?? [`ran ${humanize(e.action ?? 'an action')} on`, ''];
	const where = e.conversationTitle ?? e.conversationId;
	const d = e.detail ?? {};
	const target = where ?? (typeof d.args === 'string' ? (/(?:^|\s)(?:chat|chat_id)=(\S+)/.exec(d.args)?.[1] ?? '') : '');
	const head = target === '' ? verb : `${verb} ${prep === '' ? '' : `${prep} `}${target}`;
	const by = e.peerName ? `requested by ${e.peerName}` : typeof d.origin === 'string' && d.origin !== 'chat' ? `by a ${d.origin}` : 'by the agent';
	const bits = [`${head}, ${by}`];
	if (d.result === 'rate_limited') bits.push(`rate limited${e.reason ? ` (${e.reason})` : ''}`);
	else if (d.result === 'error') bits.push(`failed${e.reason ? `: ${e.reason}` : ''}`);
	if (typeof d.args === 'string' && d.args !== '') bits.push(`[${d.args}]`);
	if (typeof d.ms === 'number') bits.push(`${d.ms} ms`);
	return bits.join(' · ');
}

export const EVENT_TYPES = Object.keys(EVENT_LABEL) as ActivityType[];

export const DROP_REASON_LABEL: Record<string, string> = {
	'unlinked-sender': 'the sender is not linked',
	'chat-not-allowed': 'the chat is not allowed',
	'dm-disabled': 'direct messages are off',
	'bot-sender': 'sent by a bot',
	'loop-guard': 'bot loop guard',
	duplicate: 'already handled (duplicate)',
	'agent-unavailable': 'the agent is archived or missing',
	'not-authorized': 'not allowed to answer the approval',
	'not-observed': 'the full log is off here and the message did not address the agent'
};

export const eventTone = (t: ActivityType): Tone =>
	t === 'reply-failed' || t === 'breaker-opened' || t === 'needs-auth'
		? 'destructive'
		: t === 'reply-retried' || t === 'dropped' || t === 'parked'
			? 'warning'
			: t === 'woke' || t === 'reply-sent' || t === 'approval-answered'
				? 'success'
				: 'secondary';

/** The badge tone of one event: an action that failed or was held back shows it. */
export const eventToneOf = (e: ChannelActivity): Tone =>
	(e.type === 'action' || e.type === 'read') && e.detail?.result === 'error' ? 'destructive' : (e.type === 'action' || e.type === 'read') && e.detail?.result === 'rate_limited' ? 'warning' : eventTone(e.type);

/** One sentence for an event: who, where and why (never message text: there is none). */
export function eventText(e: ChannelActivity): string {
	if (e.type === 'action' || e.type === 'read') return actionText(e);
	if (e.type === 'parked') return `${e.reason ?? 'the platform asked to slow down'}${typeof e.detail?.seconds === 'number' ? `, paused for ${e.detail.seconds} s` : ''}${e.detail?.scope === 'chat' ? ' (one chat)' : ''}`;
	const who = e.peerName ?? (e.peerId ? `Telegram ${e.peerId}` : undefined);
	const where = e.conversationTitle ?? e.conversationId;
	const bits: string[] = [];
	if (who) bits.push(who);
	if (where && where !== e.peerName) bits.push(`in ${where}`);
	const reason = e.type === 'dropped' ? (DROP_REASON_LABEL[e.reason ?? ''] ?? e.reason) : e.reason;
	if (reason) bits.push(`(${reason})`);
	const d = e.detail;
	if (d !== undefined) {
		if (typeof d.tool === 'string') bits.push(`tool ${d.tool}`);
		if (typeof d.chunks === 'number' && d.chunks > 1) bits.push(`${d.chunks} parts`);
		if (typeof d.attempt === 'number') bits.push(`attempt ${d.attempt}`);
	}
	return bits.join(' ');
}


// --- people directory and reminders (L6) ---------------------------------------------------------

export const ROLES: { value: Role; label: string; hint: string }[] = [
	{ value: 'owner', label: 'Owner', hint: 'Everything, including approvals in a chat.' },
	{ value: 'admin', label: 'Admin', hint: 'Approvals in a chat, reminders for others, writes and deletes.' },
	{ value: 'member', label: 'Member', hint: 'Reads and recaps of their divisions, their own reminders.' },
	{ value: 'guest', label: 'Guest', hint: 'Answers only: no tools.' }
];
export const roleLabel = (r: Role): string => ROLES.find((x) => x.value === r)?.label ?? r;

export function roleSourceLabel(p: ChannelPerson): string {
	switch (p.roleSource) {
		case 'directory':
			return 'set by the team';
		case 'linked-admin':
			return 'linked team admin';
		case 'linked-member':
			return 'linked team member';
		case 'anonymous':
			return 'anonymous admin or channel: identity unknown, always a guest';
		case 'bot':
			return 'bot, always a guest';
		default:
			return 'default, not in the directory';
	}
}

/** The platform's own word for the admin status of a person ("admin in TEAMKU (CEO)"). */
export function platformAdminText(p: ChannelPerson): string {
	return p.platformAdmin
		.map((a) => `${a.role === 'owner' ? 'creator' : 'admin'} in ${a.title}${a.customTitle ? ` (${a.customTitle})` : ''}`)
		.join(', ');
}

/** The role of an anonymous admin or a bot cannot be changed. */
export const roleLocked = (p: ChannelPerson): boolean => p.roleSource === 'anonymous' || p.roleSource === 'bot';

/** Chats and topics a person can be given as divisions, with the room named for a topic. */
export function divisionOptions(chats: readonly ChannelChat[]): { id: string; label: string }[] {
	const byId = new Map(chats.map((c) => [c.id, c]));
	return chats
		.filter((c) => c.state !== 'deleted' && c.state !== 'left')
		.map((c) => {
			const parent = c.parentId === undefined ? undefined : byId.get(c.parentId);
			return { id: c.id, label: parent === undefined ? c.title : `${parent.title} / ${c.title}` };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

export const personName = (p: ChannelPerson): string => p.name ?? (p.username ? `@${p.username}` : `id ${p.peerId}`);


// ---- navigation of the Channels pages ----

export type SectionId = 'overview' | 'chats' | 'people' | 'inbox' | 'activity' | 'events' | 'reminders' | 'router' | 'delivery' | 'history' | 'admin-log' | 'settings';

export interface Section {
	id: SectionId;
	label: string;
}

/**
 * The sections of one connection, in menu order. A connection runs with or without an answering
 * agent (without one it records observe-only), so every section is there; a user account adds its
 * history and admin log, a bot its reminders.
 */
export function sectionsOf(c: Pick<ChannelConnection, 'binding' | 'transport'> | null): Section[] {
	const bound = c !== null;
	const account = c?.transport === 'user';
	const all: Array<Section | false> = [
		{ id: 'overview', label: 'Overview' },
		bound && { id: 'chats', label: account ? 'Chats to read' : 'Chats' },
		bound && { id: 'people', label: 'People' },
		bound && { id: 'inbox', label: 'Inbox' },
		bound && { id: 'activity', label: 'Activity' },
		bound && { id: 'events', label: 'Events' },
		bound && !account && { id: 'reminders', label: 'Reminders' },
		bound && { id: 'router', label: 'Router' },
		bound && { id: 'delivery', label: account ? 'Send limits' : 'Delivery' },
		bound && account && { id: 'history', label: 'History' },
		bound && account && { id: 'admin-log', label: 'Admin log' },
		{ id: 'settings', label: 'Settings' }
	];
	return all.filter((x): x is Section => x !== false);
}

export const SECTION_TITLE: Record<SectionId, string> = {
	overview: 'Overview',
	chats: 'Chats',
	people: 'People',
	inbox: 'Inbox',
	activity: 'Activity',
	events: 'Events',
	reminders: 'Reminders',
	router: 'Router',
	delivery: 'Delivery',
	history: 'History',
	'admin-log': 'Admin log',
	settings: 'Settings'
};

/** `/channels/<id>[/<section>[/<detail>]]`, every part encoded. */
export const channelHref = (id: string, ...parts: string[]): string => ['/channels', id, ...parts].map((x, i) => (i === 0 ? x : encodeURIComponent(x))).join('/');

/** The section a path of a connection is in (`overview` for the connection itself). */
export function sectionOfPath(pathname: string, id: string): SectionId {
	const base = channelHref(id);
	const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split('/')[0] : '';
	const found = (Object.keys(SECTION_TITLE) as SectionId[]).find((s) => s === rest);
	return found ?? 'overview';
}

/** The `@username` (or the account label) shown next to the name of a connection. */
export const connectionHandle = (c: ChannelConnection): string | undefined => (c.bot ? `@${c.bot.username}` : c.account?.username ? `@${c.account.username}` : c.accountLabel);

/** What needs a person's eye, in plain sentences (empty = all is well). */
export function attentionOf(c: ChannelConnection): string[] {
	const out: string[] = [];
	const hint = isAccount(c) ? accountHint(c) : stateHint(c);
	if (hint !== '' && c.runtime.state !== 'unbound') out.push(hint);

	if (c.counts.unlinked > 0) out.push(`${c.counts.unlinked} ${c.counts.unlinked === 1 ? 'person has' : 'people have'} written directly and ${c.counts.unlinked === 1 ? 'is' : 'are'} not linked.`);
	if (c.counts.outboxFailed > 0) out.push(`${c.counts.outboxFailed} ${c.counts.outboxFailed === 1 ? 'message' : 'messages'} could not be sent.`);
	if (c.breaker?.open) out.push('Sending is paused after errors.');
	return out;
}

/** How many things need attention (the badge on a card). */
export const attentionCount = (c: ChannelConnection): number => attentionOf(c).length;

/** A connection that works: running, nothing waiting for a person. */
export const isHealthy = (c: ChannelConnection): boolean => c.runtime.state === 'running' && attentionCount(c) === 0;

/** Table filters used by several pages. */
export const YES_NO_ALL = (yes: string, no: string): { value: string; label: string }[] => [
	{ value: '', label: 'All' },
	{ value: 'yes', label: yes },
	{ value: 'no', label: no }
];
