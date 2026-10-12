// The Channels page's view model (Telegram bot connections, chats, people, delivery). Pure.
import type { components } from '../api/schema';

export type ChannelConnection = components['schemas']['ChannelConnection'];
export type ChannelChat = components['schemas']['ChannelChat'];
export type ChannelLink = components['schemas']['ChannelLink'];
export type ChannelPairing = components['schemas']['ChannelPairing'];
export type ChannelPolicy = NonNullable<components['schemas']['ChannelChat']['policy']>;
export type ChannelPolicyBody = components['schemas']['ChannelPolicyBody'];
export type RuntimeState = ChannelConnection['runtime']['state'];
export type Wake = NonNullable<ChannelPolicy['wake']>;
export type Delivery = NonNullable<ChannelPolicy['delivery']>;

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

export const BOT_STATUS_LABEL: Record<string, string> = {
	administrator: 'Admin',
	creator: 'Owner',
	member: 'Member',
	restricted: 'Restricted',
	left: 'Left',
	kicked: 'Removed'
};
export const botStatusLabel = (s: string | undefined): string => (s === undefined ? 'Unknown' : (BOT_STATUS_LABEL[s] ?? s));
/** The bot is not in the chat any more (it cannot read or post). */
export const botGone = (c: ChannelChat): boolean => c.botStatus === 'left' || c.botStatus === 'kicked';

/** The form of one chat policy as typed. */
export interface PolicyForm {
	allowed: boolean;
	wake: Wake;
	delivery: Delivery;
	/** Days, as typed; empty = the default (30). */
	retention: string;
}

export const formOfChat = (c: ChannelChat): PolicyForm => ({
	allowed: c.effective.allowed,
	wake: c.policy?.wake ?? c.effective.wake,
	delivery: c.policy?.delivery ?? c.effective.delivery,
	retention: c.policy?.retentionDays === undefined ? '' : String(c.policy.retentionDays)
});

export function retentionError(text: string): string | undefined {
	if (text.trim() === '') return undefined;
	const n = Number(text);
	return Number.isInteger(n) && n >= 1 && n <= 3650 ? undefined : 'Whole days, 1 to 3650';
}

/** The body of the PATCH for a form (every field explicit: it is the whole policy of the chat). */
export function policyBody(f: PolicyForm): ChannelPolicyBody {
	return {
		enabled: f.allowed,
		wake: f.wake,
		delivery: f.delivery,
		retentionDays: f.retention.trim() === '' ? null : Number(f.retention)
	};
}

export const formChanged = (a: PolicyForm, b: PolicyForm): boolean =>
	a.allowed !== b.allowed || a.wake !== b.wake || a.delivery !== b.delivery || a.retention.trim() !== b.retention.trim();

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

export const KIND_LABEL: Record<ChannelChat['kind'], string> = { dm: 'Direct', group: 'Group', channel: 'Channel' };

/**
 * A warning when the bot cannot see what the policies ask of it: privacy mode hides ordinary
 * messages in groups, so "every message" and "observe only" need an admin bot (or privacy off).
 */
export function privacyWarning(c: ChannelConnection, chats: readonly ChannelChat[]): string | undefined {
	if (c.bot === undefined || c.bot.canReadAllGroupMessages) return undefined;
	const needsAll = chats.filter(
		(x) => x.kind !== 'channel' && x.effective.allowed && x.effective.wake !== 'mention' && x.botStatus !== 'administrator' && x.botStatus !== 'creator'
	);
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

/** The deep link shown once, with how long it lives. */
export function pairingText(p: ChannelPairing, now: number): string {
	const hours = Math.max(1, Math.round((p.expiresAt - now) / 3_600_000));
	return `Valid for ${hours} hour${hours === 1 ? '' : 's'}. Open it in Telegram on the person's phone or desktop and press Start.`;
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

/** Chats of an account: chosen ones first, then by title. */
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
