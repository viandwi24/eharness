// The Channels page's view model (Telegram bot connections, chats, people, delivery). Pure.
import type { components } from '../api/schema';

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
			return 'Choose the agent that answers on this bot. Polling starts when you do.';
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
	/** Days, as typed; empty = inherit. */
	retention: string;
	observe: Tri;
	sessionScope: Inherit<SessionScope>;
	redactOnDelete: Tri;
	/** Proactive posts (what the agent says unasked): allowed, quiet hours, digest, mention limit. */
	proactive: Tri;
	quietFrom: string;
	quietTo: string;
	digest: Tri;
	maxMentions: string;
}

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
	maxMentions: c.policy?.proactive?.maxMentions === undefined ? '' : String(c.policy.proactive.maxMentions)
});

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A problem with the quiet hours or the mention limit as typed, or undefined. */
export function proactiveError(f: Pick<PolicyForm, 'quietFrom' | 'quietTo' | 'maxMentions'>): string | undefined {
	const from = f.quietFrom.trim();
	const to = f.quietTo.trim();
	if ((from === '') !== (to === '')) return 'Quiet hours need both a start and an end';
	if (from !== '' && (!CLOCK.test(from) || !CLOCK.test(to))) return 'Quiet hours are HH:MM (24 hours)';
	const m = f.maxMentions.trim();
	if (m !== '' && !(Number.isInteger(Number(m)) && Number(m) >= 0 && Number(m) <= 20)) return 'Mention limit: 0 to 20';
	return undefined;
}

export function retentionError(text: string): string | undefined {
	if (text.trim() === '') return undefined;
	const n = Number(text);
	return Number.isInteger(n) && n >= 1 && n <= 3650 ? undefined : 'Whole days, 1 to 3650';
}

/** The body of the PATCH for a form (every field explicit: `null` clears a setting so it inherits again). */
export function policyBody(f: PolicyForm): ChannelPolicyBody {
	return {
		enabled: boolOf(f.allowed),
		wake: f.wake === '' ? null : f.wake,
		delivery: f.delivery === '' ? null : f.delivery,
		retentionDays: f.retention.trim() === '' ? null : Number(f.retention),
		observe: boolOf(f.observe),
		sessionScope: f.sessionScope === '' ? null : f.sessionScope,
		redactOnDelete: boolOf(f.redactOnDelete),
		proactive: proactiveBody(f)
	};
}

/** The proactive object of a form: only what is set; null when nothing is (inherit again). */
export function proactiveBody(f: PolicyForm): ChannelPolicyBody['proactive'] {
	const allowed = boolOf(f.proactive);
	const digest = boolOf(f.digest);
	const quiet = f.quietFrom.trim() !== '' && f.quietTo.trim() !== '' ? { from: f.quietFrom.trim(), to: f.quietTo.trim() } : undefined;
	const max = f.maxMentions.trim() === '' ? undefined : Number(f.maxMentions);
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
	a.retention.trim() !== b.retention.trim() ||
	a.observe !== b.observe ||
	a.sessionScope !== b.sessionScope ||
	a.redactOnDelete !== b.redactOnDelete ||
	a.proactive !== b.proactive ||
	a.quietFrom.trim() !== b.quietFrom.trim() ||
	a.quietTo.trim() !== b.quietTo.trim() ||
	a.digest !== b.digest ||
	a.maxMentions.trim() !== b.maxMentions.trim();

/** Where one effective setting comes from, in words ("set here", "inherited from Company"). */
export function originText(c: ChannelChat, key: keyof ChannelChat['inherited'], titleOf: (nodeId: string) => string): string {
	const o = c.inherited[key];
	if (o === undefined || o.from === 'default') return 'default';
	if (o.from === 'connection') return 'connection default';
	if (o.from === 'node') return 'set here';
	return `inherited from ${o.nodeId === undefined ? 'above' : titleOf(o.nodeId)}`;
}

/** One line for the chat row. */
export function chatSummary(c: ChannelChat): string {
	if (!c.effective.allowed) return 'Not allowed: the agent ignores this chat';
	const parts = [wakeLabel(c.effective.wake), deliveryLabel(c.effective.delivery), `${c.effective.retentionDays} days`];
	return parts.join(' · ');
}

/** Allowed chats first, then the ones the bot is still in, then the most recently heard from. */
export function sortChats(chats: readonly ChannelChat[]): ChannelChat[] {
	return [...chats].sort(
		(a, b) => Number(b.effective.allowed) - Number(a.effective.allowed) || Number(botGone(a)) - Number(botGone(b)) || b.lastSeen - a.lastSeen
	);
}

/** A node with its children (a forum with its topics). */
export interface ChatBranch {
	chat: ChannelChat;
	children: ChatBranch[];
}

/**
 * The tree of chats and topics: roots sorted like {@link sortChats}, children by name (General
 * first). A node whose parent is not in the list is a root.
 */
export function chatTree(chats: readonly ChannelChat[]): ChatBranch[] {
	const ids = new Set(chats.map((c) => c.id));
	const byParent = new Map<string, ChannelChat[]>();
	const roots: ChannelChat[] = [];
	for (const c of chats) {
		if (c.parentId !== undefined && ids.has(c.parentId)) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
		else roots.push(c);
	}
	const general = (c: ChannelChat): number => (c.platformType.endsWith('forum_general') ? 0 : 1);
	const branch = (c: ChannelChat): ChatBranch => ({
		chat: c,
		children: (byParent.get(c.id) ?? []).sort((a, b) => general(a) - general(b) || a.title.localeCompare(b.title)).map(branch)
	});
	return sortChats(roots).map(branch);
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
	const { outboxPending: p, outboxFailed: f } = c.counts;
	const parts = [p === 0 ? 'Nothing waiting' : `${p} waiting to send`];
	if (f > 0) parts.push(`${f} failed`);
	return parts.join(' · ');
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

/** Chats of an account (rooms, not their topics): chosen ones first, then by title. */
export const sortAccountChats = (chats: readonly ChannelChat[]): ChannelChat[] =>
	[...chats].sort((a, b) => Number(!!b.account?.selected) - Number(!!a.account?.selected) || a.title.localeCompare(b.title));

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
	if (b.oldestAt !== undefined) parts.push(`back to ${new Date(b.oldestAt).toISOString().slice(0, 10)}`);
	if (b.state === 'parked' && b.parkedUntil !== undefined) parts.push(`resumes in about ${Math.max(1, Math.ceil((b.parkedUntil - now) / 60_000))} min`);
	if (b.error) parts.push(b.error);
	return parts.join(' · ');
}

export const lastWindowDays = (text: string): number | null | undefined => {
	if (text.trim() === '') return null;
	const n = Number(text);
	return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : undefined;
};

/** The limits form as typed (numbers as strings) and its PATCH body; undefined fields are left out. */
export interface LimitsForm {
	dmDailyMax: string;
	dailyMax: string;
	adminLogHours: string;
}
export const limitsFormOf = (l: AccountLimits): LimitsForm => ({
	dmDailyMax: String(l.dmDailyMax),
	dailyMax: String(l.dailyMax),
	adminLogHours: String(Math.round(l.adminLogEveryMs / 360_000) / 10)
});
export function limitsBody(f: LimitsForm): { body: { dmDailyMax: number; dailyMax: number; adminLogEveryMs: number } } | { error: string } {
	const int = (t: string, max: number): number | undefined => {
		const n = Number(t);
		return t.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
	};
	const dm = int(f.dmDailyMax, 1000);
	const all = int(f.dailyMax, 5000);
	const hours = Number(f.adminLogHours);
	if (dm === undefined) return { error: 'Direct messages a day: a whole number, 0 to 1000 (0 = none)' };
	if (all === undefined) return { error: 'Messages a day: a whole number, 0 to 5000 (0 = none)' };
	if (!(hours >= 1 / 60) || f.adminLogHours.trim() === '') return { error: 'Admin log interval: hours, at least 1 minute' };
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
			return 'Choose the agent that owns this account. Chats you select stay observe-only until you change their policy.';
		default:
			return '';
	}
}

// ---- people: linking without links ----

/** What a person shows as: name, @username, else the platform id. */
export function unlinkedLabel(u: Pick<ChannelUnlinked, 'name' | 'username' | 'peerId'>): string {
	return u.name ?? (u.username ? `@${u.username}` : `Telegram ${u.peerId}`);
}

/** The secondary line of a not-yet-linked person: id, username, how often and when they wrote. */
export function unlinkedDetail(u: ChannelUnlinked, now: number): string {
	const parts = [`id ${u.peerId}`];
	if (u.username && u.name) parts.push(`@${u.username}`);
	parts.push(`${u.messageCount} message${u.messageCount === 1 ? '' : 's'}`, `last ${ago(u.lastSeen, now)}`);
	return parts.join(' · ');
}

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
	return d <= 7 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(at).toISOString().slice(0, 10);
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
	return who === undefined ? p.text : `${who}: ${p.text}`;
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
	'needs-auth': 'Needs sign-in'
};

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
		: t === 'reply-retried' || t === 'dropped'
			? 'warning'
			: t === 'woke' || t === 'reply-sent' || t === 'approval-answered'
				? 'success'
				: 'secondary';

/** One sentence for an event: who, where and why (never message text: there is none). */
export function eventText(e: ChannelActivity): string {
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

/** Suggestions first, then staff, then the most recently seen. */
export function sortPeople(people: readonly ChannelPerson[]): ChannelPerson[] {
	const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2, guest: 3 };
	return [...people].sort(
		(a, b) => Number(b.suggestion !== undefined) - Number(a.suggestion !== undefined) || rank[a.role] - rank[b.role] || b.lastSeen - a.lastSeen
	);
}

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
