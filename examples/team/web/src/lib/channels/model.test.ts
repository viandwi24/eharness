import { describe, expect, test } from 'bun:test';
import {
	agentChoices,
	attentionOf,
	channelHref,
	isHealthy,
	sectionOfPath,
	sectionsOf,
	ago,
	allowlistLabel,
	approvalOutcome,
	eventText,
	eventTone,
	eventToneOf,
	inboxCounts,
	messageMarks,
	peerIdError,
	previewLine,
	threadHref,
	breakerText,
	divisionOptions,
	platformAdminText,
	proactiveBody,
	proactiveError,
	roleLocked,
	type ChannelPerson,
	formChanged,
	formOfChat,
	originText,
	outboxSummary,
	attentionReason,
	attentionKind,
	needsALookCount,
	HELD_HELP,
	policyBody,
	privacyWarning,
	retentionError,
	fieldText,
	connectionText,
	wakeHint,
	quietText,
	limitsBody,
	lastWindowDays,
	sortConnections,
	stateHint,
	stateTone,
	type ChannelActivity,
	type ChannelChat,
	type ChannelConnection,
	type InboxConversation,
	type LogMessage
} from './model';

const effective = (over: Partial<ChannelChat['effective']> = {}): ChannelChat['effective'] => ({
	allowed: false,
	agentId: 'lead',
	wake: 'mention',
	delivery: 'final_text',
	retentionDays: 30,
	observe: true,
	sessionScope: 'node',
	redactOnDelete: false,
	proactive: { allowed: false, digest: true, digestMinutes: 60, maxMentions: 3 },
	...over
});
const chat = (over: Partial<ChannelChat> = {}): ChannelChat => ({
	id: 'n-1',
	nativeId: '-1',
	kind: 'room',
	chatKind: 'group',
	platformType: 'telegram:supergroup',
	title: 'Ops',
	state: 'active',
	container: false,
	postable: true,
	firstSeen: 1,
	lastSeen: 10,
	policy: null,
	effective: effective(),
	inherited: {},
	...over
});
const conn = (over: Partial<ChannelConnection> = {}): ChannelConnection => ({
	id: 'c1',
	platform: 'telegram',
	label: 'Team bot',
	connectionStatus: 'connected',
	enabled: true,
	runtime: { state: 'running', since: 1 },
	binding: null,
	counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 0, outboxFailed: 0, outboxHeld: 0 },
	...over
});

describe('state', () => {
	test('tones and hints tell what to do next', () => {
		expect(stateTone('running')).toBe('success');
		expect(stateTone('needs-auth')).toBe('destructive');
		expect(stateTone('webhook')).toBe('warning');
		expect(stateTone('unbound')).toBe('secondary');
		expect(stateHint(conn({ runtime: { state: 'unbound', since: 1 } }))).toContain('Choose the agent');
		expect(stateHint(conn({ runtime: { state: 'webhook', since: 1 } }))).toContain('Remove the webhook');
		expect(stateHint(conn({ runtime: { state: 'error', since: 1, message: 'boom' } }))).toBe('boom');
		expect(stateHint(conn())).toBe('');
	});
});

describe('chat policy form', () => {
	test('the form is what the node sets itself; "" inherits; the body clears what is inherited', () => {
		const c = chat({
			effective: effective({ allowed: true, wake: 'never', delivery: 'message_tool', retentionDays: 7 }),
			policy: { enabled: true, wake: 'never', retentionDays: 7 },
			inherited: { enabled: { from: 'node', nodeId: 'n-1' }, wake: { from: 'node', nodeId: 'n-1' }, delivery: { from: 'connection' } }
		});
		const f = formOfChat(c);
		expect(f).toEqual({ allowed: 'on', wake: 'never', delivery: '', retention: '7', observe: '', sessionScope: '', redactOnDelete: '', proactive: '', quietFrom: '', quietTo: '', digest: '', maxMentions: '', defaultRole: '', replyStyle: '', personaOverlay: '' });
		expect(policyBody(f)).toEqual({ enabled: true, wake: 'never', delivery: null, retentionDays: 7, observe: null, sessionScope: null, redactOnDelete: null, proactive: null, defaultRole: null, replyStyle: null, personaOverlay: null });
		// the trusted internal group switch writes the role of unknown people
		expect(policyBody({ ...f, defaultRole: 'member' })).toMatchObject({ defaultRole: 'member' });
		expect(formChanged(f, { ...f, defaultRole: 'member' })).toBe(true);
		expect(policyBody({ ...f, retention: '', allowed: '' }).retentionDays).toBeNull();
		expect(policyBody({ ...f, allowed: 'off', observe: 'off' })).toMatchObject({ enabled: false, observe: false });
		expect(formChanged(f, { ...f, wake: 'mention' })).toBe(true);
		expect(formChanged(f, { ...f, retention: ' 7 ' })).toBe(false);
		// a topic that only sets its wake does not own `enabled`, though the policy reads enabled: true
		const topic = chat({ policy: { enabled: true, wake: 'never' }, inherited: { enabled: { from: 'ancestor', nodeId: 'n-0' }, wake: { from: 'node', nodeId: 'n-1' } } });
		expect(formOfChat(topic).allowed).toBe('');
	});
	test('where a setting comes from', () => {
		const titles: Record<string, string> = { 'n-0': 'Company' };
		const titleOf = (id: string): string => titles[id] ?? id;
		const c = chat({ inherited: { wake: { from: 'ancestor', nodeId: 'n-0' }, delivery: { from: 'connection' }, retentionDays: { from: 'default' }, observe: { from: 'node', nodeId: 'n-1' } } });
		expect(originText(c, 'wake', titleOf)).toBe('inherited from Company');
		expect(originText(c, 'delivery', titleOf)).toBe('connection default');
		expect(originText(c, 'retentionDays', titleOf)).toBe('default');
		expect(originText(c, 'observe', titleOf)).toBe('set here');
	});
	test('retention is whole days from 1 to 3650', () => {
		expect(retentionError('')).toBeUndefined();
		expect(retentionError('30')).toBeUndefined();
		expect(retentionError('0')).toBeDefined();
		expect(retentionError('1.5')).toBeDefined();
		expect(retentionError('9999')).toBeDefined();
		expect(retentionError('abc')).toBeDefined();
	});
});

describe('privacy mode warning', () => {
	const bot = { id: 1, username: 'b', name: 'B', canReadAllGroupMessages: false, guidance: '' };
	const allowed = (over: Partial<ChannelChat>) => chat({ effective: effective({ allowed: true, wake: 'always' }), ...over });
	test('warns only when a policy needs more than mentions and the bot is no admin', () => {
		expect(privacyWarning(conn({ bot }), [allowed({ title: 'Ops' })])).toContain('Ops');
		expect(privacyWarning(conn({ bot }), [allowed({ member: 'admin' })])).toBeUndefined();
		expect(privacyWarning(conn({ bot }), [allowed({ chatKind: 'channel' })])).toBeUndefined();
		// a forum holds no messages of its own: its topics decide
		expect(privacyWarning(conn({ bot }), [allowed({ postable: false })])).toBeUndefined();
		expect(privacyWarning(conn({ bot }), [chat({ effective: effective({ allowed: true }) })])).toBeUndefined();
		expect(privacyWarning(conn({ bot: { ...bot, canReadAllGroupMessages: true } }), [allowed({})])).toBeUndefined();
		expect(privacyWarning(conn(), [allowed({})])).toBeUndefined();
	});
});

describe('delivery text', () => {
	test('outbox and breaker', () => {
		expect(outboxSummary(conn())).toBe('Nothing waiting');
		expect(outboxSummary(conn({ counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 2, outboxFailed: 1, outboxHeld: 0 } }))).toBe('2 waiting to send · 1 failed');
		expect(outboxSummary(conn({ counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 0, outboxFailed: 0, outboxHeld: 2 } }))).toBe('Nothing waiting · Held after a restart: 2');
		expect(outboxSummary(conn({ counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 1, outboxFailed: 3, outboxHeld: 1 } }))).toBe('1 waiting to send · Held after a restart: 1 · 3 failed');
		expect(breakerText(conn(), 0)).toBeUndefined();
		expect(breakerText(conn({ breaker: { open: true, until: 5 * 60_000, reason: 'forbidden' } }), 0)).toContain('about 5 min');
	});
	test('messages that need a look are told in plain words', () => {
		expect(attentionReason({ status: 'held', uncertain: true, reason: null, kind: 'reply' })).toContain('checking the chat');
		expect(attentionReason({ status: 'failed', uncertain: true, reason: 'x', kind: 'reply' })).toContain('could not confirm whether it arrived');
		expect(attentionReason({ status: 'failed', uncertain: false, reason: 'interrupted before it was sent; a tool call is never re-executed', kind: 'post' })).toContain('never run twice');
		expect(attentionReason({ status: 'failed', uncertain: false, reason: 'chat not found', kind: 'reply' })).toBe('Could not be sent: chat not found');
		expect(attentionReason({ status: 'failed', uncertain: false, reason: null, kind: 'reply' })).toBe('Could not be sent.');
		expect(attentionKind('approval')).toBe('Approval request');
		expect(attentionKind('reply')).toBe('Reply');
		expect(needsALookCount(3, false)).toBe('3');
		expect(needsALookCount(20, true)).toBe('20+');
		expect(HELD_HELP).toContain('nothing is sent twice');
	});
	test('agents and connections lists', () => {
		expect(agentChoices([{ id: '1', name: 'a' }, { id: '2', name: 'b', archivedAt: 5 }]).map((a) => a.id)).toEqual(['1']);
		const running = conn({ id: 'r', label: 'B', runtime: { state: 'running', since: 1 }, binding: { agentId: 'x', groupPolicy: 'allowlist', dm: 'pairing', allowBots: false, replyToUnknown: false, replyMissed: true, missedWindowMinutes: 30, admins: [], historyLimit: 50, defaults: {} } });
		const loose = conn({ id: 'l', label: 'A', runtime: { state: 'unbound', since: 1 } });
		expect(sortConnections([loose, running]).map((c) => c.id)).toEqual(['r', 'l']);
	});
});

describe('channel types and the account card', () => {
	test('channelTypes keeps only channel connectors', async () => {
		const m = await import('./model');
		const list = [
			{ id: 'github', name: 'GitHub', description: '', category: 'dev' },
			{ id: 'telegram-bot', name: 'Telegram bot', description: '', category: 'channels' }
		];
		expect(m.channelTypes(list).map((c) => c.id)).toEqual(['telegram-bot']);
	});
	test('limitsBody validates and converts hours', async () => {
		const m = await import('./model');
		expect(m.limitsBody({ dmDailyMax: '5', dailyMax: '40', adminLogHours: '2' })).toEqual({ body: { dmDailyMax: 5, dailyMax: 40, adminLogEveryMs: 7_200_000 } });
		expect('error' in m.limitsBody({ dmDailyMax: 'x', dailyMax: '40', adminLogHours: '2' })).toBe(true);
		expect('error' in m.limitsBody({ dmDailyMax: '5', dailyMax: '40', adminLogHours: '' })).toBe(true);
	});
	test('lastWindowDays', async () => {
		const m = await import('./model');
		expect(m.lastWindowDays('')).toBeNull();
		expect(m.lastWindowDays('30')).toBe(30);
		expect(m.lastWindowDays('0')).toBeUndefined();
	});
});

describe('linking without links', () => {
	test('id validation', () => {
		expect(peerIdError('123456789')).toBeUndefined();
		expect(peerIdError(' 42 ')).toBeUndefined();
		expect(peerIdError('abc')).toContain('number');
		expect(peerIdError('')).toContain('number');
		expect(ago(0, 10_000)).toBe('just now');
		expect(ago(0, 2 * 3_600_000)).toBe('2 h ago');
		expect(ago(0, 30 * 86_400_000)).toBe('1970-01-01');
	});
});

describe('inbox', () => {
	const c = (over: Partial<InboxConversation> = {}): InboxConversation => ({
		conversationId: 'room',
		kind: 'group',
		title: 'Ops',
		container: 'room',
		agentId: 'lead',
		allowed: true,
		woke: 2,
		observed: 5,
		dropped: 0,
		firstAt: 1,
		lastAt: 2,
		...over
	});
	test('counters, preview, allowlist state and the thread link', () => {
		expect(inboxCounts(c())).toBe('2 woke the agent · 5 observed');
		expect(inboxCounts(c({ dropped: 3 }))).toContain('3 dropped');
		expect(previewLine(c())).toBe('Nothing stored');
		expect(previewLine(c({ preview: { text: 'hi', at: 1, self: false, sender: 'Ana' } }))).toBe('Ana: hi');
		expect(previewLine(c({ preview: { text: 'done', at: 1, self: true } }))).toBe('Agent: done');
		expect(previewLine(c({ preview: { text: '**What is ready**\n- a', at: 1, self: true } }))).toBe('Agent: What is ready a');
		expect(allowlistLabel(c())).toBe('Allowed');
		expect(allowlistLabel(c({ allowed: false }))).toBe('Not allowed');
		expect(allowlistLabel(c({ allowed: false, kind: 'dm' }))).toBe('Not linked');
		expect(threadHref(c())).toBeUndefined();
		expect(threadHref(c({ threadId: 't 1' }))).toBe('/a/lead?t=t%201');
	});
	test('marks and approval outcomes of logged messages', () => {
		const m = (over: Partial<LogMessage> = {}): LogMessage => ({ id: '1', platformId: 'p', at: 1, self: false, text: 'x', attachments: [], ...over });
		expect(messageMarks(m({ disposition: 'observed' }))).toEqual(['Observed']);
		expect(messageMarks(m({ disposition: 'woke', editedAt: 2 }))).toEqual(['Woke the agent', 'Edited']);
		expect(messageMarks(m({ self: true, deletedAt: 3 }))).toEqual(['Agent', 'Deleted']);
		const approval = { kind: 'approval' as const, toolName: 'channel_send', status: 'answered' as const, outcome: 'approved', answeredBy: 'Ana' };
		expect(messageMarks(m({ self: true, approval }))).toEqual(['Approval request']);
		expect(approvalOutcome(approval)).toBe('Approved by Ana');
		expect(approvalOutcome({ ...approval, outcome: 'web', answeredBy: undefined })).toBe('Answered in the web app');
		expect(approvalOutcome({ ...approval, status: 'open' })).toBe('Waiting for an answer');
	});
});

describe('activity', () => {
	const e = (over: Partial<ChannelActivity>): ChannelActivity => ({ id: '1', at: 1, type: 'woke', ...over });
	test('tones and sentences, with readable drop reasons', () => {
		expect(eventTone('reply-failed')).toBe('destructive');
		expect(eventTone('dropped')).toBe('warning');
		expect(eventTone('woke')).toBe('success');
		expect(eventTone('observed')).toBe('secondary');
		expect(eventText(e({ peerName: 'Ana', conversationTitle: 'Ops', reason: 'mentioned' }))).toBe('Ana in Ops (mentioned)');
		expect(eventText(e({ peerName: 'Ana', conversationTitle: 'Ana', reason: 'DM' }))).toBe('Ana (DM)');
		expect(eventText(e({ type: 'dropped', peerId: '9', reason: 'unlinked-sender' }))).toBe('Telegram 9 (the sender is not linked)');
		expect(eventText(e({ type: 'reply-sent', conversationId: 'room', detail: { kind: 'reply', chunks: 2 } }))).toBe('in room 2 parts');
		expect(eventText(e({ type: 'approval-answered', reason: 'approved', detail: { tool: 'channel_send' } }))).toBe('(approved) tool channel_send');
	});

	test('actions and reads of the agent read as sentences: what, where, who asked, result', () => {
		const pin = e({ type: 'action', direction: 'out', action: 'pin_message', conversationTitle: 'TEAMKU / produksi', peerName: 'Vian', detail: { result: 'ok', ms: 120, args: 'chat=-100 message=5' } });
		expect(eventText(pin)).toBe('pinned a message in TEAMKU / produksi, requested by Vian · [chat=-100 message=5] · 120 ms');
		expect(eventToneOf(pin)).toBe('secondary');
		const held = e({ type: 'read', direction: 'out', action: 'history', conversationTitle: 'Ops', reason: 'rate limited, retry in 12 s', detail: { result: 'rate_limited', origin: 'routine' } });
		expect(eventText(held)).toBe('read the history of Ops, by a routine · rate limited (rate limited, retry in 12 s)');
		expect(eventToneOf(held)).toBe('warning');
		expect(eventToneOf(e({ type: 'action', action: 'ban_member', detail: { result: 'error' }, reason: 'not an admin' }))).toBe('destructive');
		expect(eventText(e({ type: 'action', action: 'create_poll_x', conversationId: 'room' }))).toBe('ran create poll x on room, by the agent');
		expect(eventText(e({ type: 'parked', reason: 'slow down', detail: { seconds: 20, scope: 'chat' } }))).toBe('slow down, paused for 20 s (one chat)');
	});
});


describe('proactive policy and the people directory', () => {
	test('the proactive form: only what is set, quiet hours need both ends', () => {
		const f = formOfChat(chat());
		expect(proactiveBody(f)).toBeNull();
		const set = { ...f, proactive: 'on' as const, quietFrom: '22:00', quietTo: '07:00', maxMentions: '2' };
		expect(proactiveBody(set)).toEqual({ allowed: true, quietHours: { from: '22:00', to: '07:00' }, maxMentions: 2 });
		expect(proactiveError({ ...set, quietTo: '' })).toContain('both');
		expect(proactiveError({ ...set, quietFrom: '25:00' })).toContain('HH:MM');
		expect(proactiveError({ ...set, maxMentions: '30' })).toContain('0 to 20');
		expect(proactiveError(set)).toBeUndefined();
		const fromServer = formOfChat(chat({ policy: { enabled: true, proactive: { allowed: false, digest: true, quietHours: { from: '21:00', to: '06:00' }, maxMentions: 0 } } }));
		expect(fromServer).toMatchObject({ proactive: 'off', digest: 'on', quietFrom: '21:00', maxMentions: '0' });
		expect(formChanged(f, set)).toBe(true);
	});

	const person = (over: Partial<ChannelPerson> = {}): ChannelPerson => ({
		peerId: '1',
		kind: 'human',
		isBot: false,
		role: 'guest',
		roleSource: 'default',
		explicit: false,
		divisions: [],
		platformAdmin: [],
		firstSeen: 1,
		lastSeen: 1,
		...over
	});
	test('anonymous admins and bots are locked; admin status reads as the platform says', () => {
		expect(roleLocked(person({ roleSource: 'anonymous' }))).toBe(true);
		expect(roleLocked(person())).toBe(false);
		expect(platformAdminText(person({ platformAdmin: [{ nodeId: 'n', title: 'TEAMKU', role: 'owner', customTitle: 'CEO' }] }))).toBe('creator in TEAMKU (CEO)');
	});
	test('divisions are chats and topics named with their room', () => {
		const room = chat({ id: 'r', title: 'TEAMKU' });
		const topic = chat({ id: 't', title: 'produksi', parentId: 'r' });
		expect(divisionOptions([topic, room])).toEqual([
			{ id: 'r', label: 'TEAMKU' },
			{ id: 't', label: 'TEAMKU / produksi' }
		]);
	});
});

describe('number inputs bound by Svelte hold numbers, not strings (U1)', () => {
	const numbers = { quietFrom: '', quietTo: '', maxMentions: 2 as string | number | null };
	test('the helpers accept numbers and null without calling string methods on them', () => {
		expect(fieldText(2)).toBe('2');
		expect(fieldText(null)).toBe('');
		expect(fieldText(' 7 ')).toBe('7');
		expect(proactiveError(numbers)).toBeUndefined();
		expect(proactiveError({ ...numbers, maxMentions: 21 })).toBe('Mention limit: 0 to 20');
		expect(proactiveError({ ...numbers, maxMentions: 1.5 })).toBe('Mention limit: 0 to 20');
		expect(proactiveError({ ...numbers, maxMentions: null })).toBeUndefined();
		expect(retentionError(30)).toBeUndefined();
		expect(retentionError(0)).toBeDefined();
		expect(retentionError(null)).toBeUndefined();
		expect(lastWindowDays(14)).toBe(14);
		expect(lastWindowDays(null)).toBeNull();
	});
	test('a form with numbers builds the body and compares like one with strings', () => {
		const base = formOfChat(chat({ policy: { retentionDays: 30, proactive: { maxMentions: 2 } } as never }));
		const typed = { ...base, retention: 45, maxMentions: 3 };
		expect(policyBody(typed)).toMatchObject({ retentionDays: 45, proactive: { maxMentions: 3 } });
		expect(policyBody({ ...base, retention: null, maxMentions: null })).toMatchObject({ retentionDays: null, proactive: null });
		expect(formChanged(base, typed)).toBe(true);
		expect(formChanged(base, { ...base, retention: 30, maxMentions: 2 })).toBe(false);
	});
	test('the limits form accepts numbers', () => {
		const r = limitsBody({ dmDailyMax: 20, dailyMax: 200, adminLogHours: 1.5 });
		expect(r).toEqual({ body: { dmDailyMax: 20, dailyMax: 200, adminLogEveryMs: 5_400_000 } });
		expect('error' in limitsBody({ dmDailyMax: null, dailyMax: 200, adminLogHours: 1 })).toBe(true);
	});
});

describe('chat row labels (U2, U3, U5)', () => {
	test('the connection is named, with what it is in the chat', () => {
		expect(connectionText('Acme bot', 'admin')).toBe('Acme bot · Admin in this chat');
		expect(connectionText('Acme bot', 'none')).toBe('Acme bot · not in this chat');
		expect(connectionText('Acme bot', undefined)).toBe('Acme bot');
	});
	test('the wake hint follows the selection, else what is in force', () => {
		expect(wakeHint('never', 'mention')).toContain('Never answers');
		expect(wakeHint('', 'always')).toContain('Reads and may answer everything');
	});
	test('inherited quiet hours read as the values in force', () => {
		expect(quietText({ from: '23:00', to: '06:30' })).toBe('23:00 to 06:30');
		expect(quietText(undefined)).toBeUndefined();
	});
});

describe('navigation of a connection', () => {
	const conn = (over: Record<string, unknown>) => ({ binding: { agentId: 'a' }, transport: 'bot', ...over }) as never;
	test('an unbound connection has only the overview and the settings', () => {
		expect(sectionsOf(conn({ binding: null })).map((s) => s.id)).toEqual(['overview', 'settings']);
		expect(sectionsOf(null).map((s) => s.id)).toEqual(['overview', 'settings']);
	});
	test('a bot has reminders and delivery, an account has history and the admin log', () => {
		expect(sectionsOf(conn({})).map((s) => s.id)).toEqual(['overview', 'chats', 'people', 'inbox', 'activity', 'events', 'reminders', 'delivery', 'settings']);
		expect(sectionsOf(conn({ transport: 'user' })).map((s) => s.id)).toEqual(['overview', 'chats', 'people', 'inbox', 'activity', 'events', 'delivery', 'history', 'admin-log', 'settings']);
	});
	test('paths and sections', () => {
		expect(channelHref('c 1', 'chats', 'n/1')).toBe('/channels/c%201/chats/n%2F1');
		expect(channelHref('c1')).toBe('/channels/c1');
		expect(sectionOfPath('/channels/c1/people/42', 'c1')).toBe('people');
		expect(sectionOfPath('/channels/c1', 'c1')).toBe('overview');
		expect(sectionOfPath('/channels/c1/unknown', 'c1')).toBe('overview');
	});
});

describe('what needs attention', () => {
	const base = { runtime: { state: 'running', since: 1 }, counts: { chats: 1, linked: 1, unlinked: 0, outboxPending: 0, outboxFailed: 0, outboxHeld: 0 }, binding: { agentId: 'a' }, transport: 'bot' };
	test('a running connection with nothing waiting is healthy', () => {
		expect(attentionOf(base as never)).toEqual([]);
		expect(isHealthy(base as never)).toBe(true);
	});
	test('unlinked people, failed sends, an open breaker and a bad state are listed in plain words', () => {
		const c = { ...base, runtime: { state: 'needs-auth', since: 1 }, counts: { ...base.counts, unlinked: 2, outboxFailed: 1 }, breaker: { open: true, until: 5, reason: 'x' } };
		const list = attentionOf(c as never);
		expect(list.length).toBe(4);
		expect(list.join(' ')).toContain('2 people have written directly');
		expect(list.join(' ')).toContain('1 message could not be sent');
		expect(isHealthy(c as never)).toBe(false);
	});
	test('an unbound connection says so', () => {
		expect(attentionOf({ ...base, binding: null, runtime: { state: 'unbound', since: 1 } } as never)).toEqual(['Not bound to an agent yet.']);
	});
});
