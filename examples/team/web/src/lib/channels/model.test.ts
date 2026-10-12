import { describe, expect, test } from 'bun:test';
import {
	agentChoices,
	ago,
	allowlistLabel,
	approvalOutcome,
	eventText,
	eventTone,
	inboxCounts,
	messageMarks,
	peerIdError,
	previewLine,
	threadHref,
	unlinkedDetail,
	unlinkedLabel,
	breakerText,
	chatSummary,
	divisionOptions,
	platformAdminText,
	proactiveBody,
	proactiveError,
	roleLocked,
	sortPeople,
	type ChannelPerson,
	formChanged,
	formOfChat,
	chatTree,
	originText,
	outboxSummary,
	policyBody,
	privacyWarning,
	retentionError,
	fieldText,
	connectionText,
	wakeHint,
	quietText,
	limitsBody,
	lastWindowDays,
	sortChats,
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
	counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 0, outboxFailed: 0 },
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
		expect(f).toEqual({ allowed: 'on', wake: 'never', delivery: '', retention: '7', observe: '', sessionScope: '', redactOnDelete: '', proactive: '', quietFrom: '', quietTo: '', digest: '', maxMentions: '' });
		expect(policyBody(f)).toEqual({ enabled: true, wake: 'never', delivery: null, retentionDays: 7, observe: null, sessionScope: null, redactOnDelete: null, proactive: null });
		expect(policyBody({ ...f, retention: '', allowed: '' }).retentionDays).toBeNull();
		expect(policyBody({ ...f, allowed: 'off', observe: 'off' })).toMatchObject({ enabled: false, observe: false });
		expect(formChanged(f, { ...f, wake: 'mention' })).toBe(true);
		expect(formChanged(f, { ...f, retention: ' 7 ' })).toBe(false);
		// a topic that only sets its wake does not own `enabled`, though the policy reads enabled: true
		const topic = chat({ policy: { enabled: true, wake: 'never' }, inherited: { enabled: { from: 'ancestor', nodeId: 'n-0' }, wake: { from: 'node', nodeId: 'n-1' } } });
		expect(formOfChat(topic).allowed).toBe('');
	});
	test('where a setting comes from, and the tree of a forum', () => {
		const titles: Record<string, string> = { 'n-0': 'Company' };
		const titleOf = (id: string): string => titles[id] ?? id;
		const c = chat({ inherited: { wake: { from: 'ancestor', nodeId: 'n-0' }, delivery: { from: 'connection' }, retentionDays: { from: 'default' }, observe: { from: 'node', nodeId: 'n-1' } } });
		expect(originText(c, 'wake', titleOf)).toBe('inherited from Company');
		expect(originText(c, 'delivery', titleOf)).toBe('connection default');
		expect(originText(c, 'retentionDays', titleOf)).toBe('default');
		expect(originText(c, 'observe', titleOf)).toBe('set here');
		const forum = chat({ id: 'f', title: 'Company', container: true, postable: false, lastSeen: 5 });
		const general = chat({ id: 'g', parentId: 'f', title: 'General', platformType: 'telegram:forum_general' });
		const billing = chat({ id: 'b', parentId: 'f', title: 'Billing', platformType: 'telegram:forum_topic' });
		const roadmap = chat({ id: 'r', parentId: 'f', title: 'Roadmap', platformType: 'telegram:forum_topic' });
		const other = chat({ id: 'o', title: 'Other', lastSeen: 9 });
		const tree = chatTree([roadmap, other, billing, forum, general]);
		expect(tree.map((b) => b.chat.id)).toEqual(['o', 'f']);
		expect(tree[1]?.children.map((b) => b.chat.title)).toEqual(['General', 'Billing', 'Roadmap']);
		// a node whose parent is not listed is a root
		expect(chatTree([billing]).map((b) => b.chat.id)).toEqual(['b']);
	});
	test('retention is whole days from 1 to 3650', () => {
		expect(retentionError('')).toBeUndefined();
		expect(retentionError('30')).toBeUndefined();
		expect(retentionError('0')).toBeDefined();
		expect(retentionError('1.5')).toBeDefined();
		expect(retentionError('9999')).toBeDefined();
		expect(retentionError('abc')).toBeDefined();
	});
	test('summary and ordering: allowed first, then still-a-member, then newest', () => {
		expect(chatSummary(chat())).toContain('Not allowed');
		expect(chatSummary(chat({ effective: effective({ allowed: true, wake: 'always', retentionDays: 14 }) }))).toBe('Every message · Reply in chat · 14 days');
		const a = chat({ id: 'a', lastSeen: 5 });
		const b = chat({ id: 'b', lastSeen: 9 });
		const c = chat({ id: 'c', lastSeen: 1, effective: effective({ allowed: true }) });
		const gone = chat({ id: 'd', lastSeen: 99, state: 'left', member: 'none' });
		expect(sortChats([a, gone, b, c]).map((x) => x.id)).toEqual(['c', 'b', 'a', 'd']);
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
		expect(outboxSummary(conn({ counts: { chats: 0, linked: 0, unlinked: 0, outboxPending: 2, outboxFailed: 1 } }))).toBe('2 waiting to send · 1 failed');
		expect(breakerText(conn(), 0)).toBeUndefined();
		expect(breakerText(conn({ breaker: { open: true, until: 5 * 60_000, reason: 'forbidden' } }), 0)).toContain('about 5 min');
	});
	test('agents and connections lists', () => {
		expect(agentChoices([{ id: '1', name: 'a' }, { id: '2', name: 'b', archivedAt: 5 }]).map((a) => a.id)).toEqual(['1']);
		const running = conn({ id: 'r', label: 'B', runtime: { state: 'running', since: 1 }, binding: { agentId: 'x', groupPolicy: 'allowlist', dm: 'pairing', allowBots: false, replyToUnknown: false, admins: [], historyLimit: 50, defaults: {} } });
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
	test('names, details and id validation', () => {
		const u = { peerId: '42', name: 'Ana', username: 'ana', firstSeen: 0, lastSeen: 3 * 60_000, messageCount: 3, ignored: false };
		expect(unlinkedLabel(u)).toBe('Ana');
		expect(unlinkedLabel({ peerId: '7', username: 'gus' })).toBe('@gus');
		expect(unlinkedLabel({ peerId: '7' })).toBe('Telegram 7');
		expect(unlinkedDetail(u, 5 * 60_000)).toBe('id 42 · @ana · 3 messages · last 2 min ago');
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
	test('the order is stable: a role change or a suggestion never moves a row; anonymous admins and bots are locked; admin status reads as the platform says', () => {
		const people = [
			person({ peerId: 'a', name: 'Gina', lastSeen: 9 }),
			person({ peerId: 'b', name: 'Budi', role: 'owner', explicit: true, roleSource: 'directory', lastSeen: 1 }),
			person({ peerId: 'c', name: 'Ana', suggestion: { role: 'admin', reason: 'admin in TEAMKU' }, lastSeen: 2 })
		];
		const before = sortPeople(people).map((p) => p.peerId);
		expect(before).toEqual(['c', 'b', 'a']);
		// Gina becomes an admin and was seen again: still after Budi
		const changed = people.map((p) => (p.peerId === 'a' ? { ...p, role: 'admin' as const, lastSeen: 99 } : p));
		expect(sortPeople(changed).map((p) => p.peerId)).toEqual(before);
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
