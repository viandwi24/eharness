import { describe, expect, test } from 'bun:test';
import {
	agentChoices,
	breakerText,
	chatSummary,
	formChanged,
	formOfChat,
	outboxSummary,
	pairingText,
	policyBody,
	privacyWarning,
	retentionError,
	sortChats,
	sortConnections,
	stateHint,
	stateTone,
	type ChannelChat,
	type ChannelConnection
} from './model';

const chat = (over: Partial<ChannelChat> = {}): ChannelChat => ({
	chatId: '-1',
	kind: 'group',
	title: 'Ops',
	forum: false,
	topics: [],
	firstSeen: 1,
	lastSeen: 10,
	policy: null,
	effective: { allowed: false, wake: 'mention', delivery: 'final_text', retentionDays: 30 },
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
	counts: { chats: 0, linked: 0, outboxPending: 0, outboxFailed: 0 },
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
	test('the form follows the effective policy; the body is the whole policy', () => {
		const c = chat({ effective: { allowed: true, wake: 'never', delivery: 'message_tool', retentionDays: 7 }, policy: { enabled: true, wake: 'never', retentionDays: 7 } });
		const f = formOfChat(c);
		expect(f).toEqual({ allowed: true, wake: 'never', delivery: 'message_tool', retention: '7' });
		expect(policyBody(f)).toEqual({ enabled: true, wake: 'never', delivery: 'message_tool', retentionDays: 7 });
		expect(policyBody({ ...f, retention: '' }).retentionDays).toBeNull();
		expect(formChanged(f, { ...f, wake: 'mention' })).toBe(true);
		expect(formChanged(f, { ...f, retention: ' 7 ' })).toBe(false);
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
		expect(chatSummary(chat({ effective: { allowed: true, wake: 'always', delivery: 'final_text', retentionDays: 14 } }))).toBe('Every message · Reply in chat · 14 days');
		const a = chat({ chatId: 'a', lastSeen: 5 });
		const b = chat({ chatId: 'b', lastSeen: 9 });
		const c = chat({ chatId: 'c', lastSeen: 1, effective: { allowed: true, wake: 'mention', delivery: 'final_text', retentionDays: 30 } });
		const gone = chat({ chatId: 'd', lastSeen: 99, botStatus: 'kicked' });
		expect(sortChats([a, gone, b, c]).map((x) => x.chatId)).toEqual(['c', 'b', 'a', 'd']);
	});
});

describe('privacy mode warning', () => {
	const bot = { id: 1, username: 'b', name: 'B', canReadAllGroupMessages: false, guidance: '' };
	const allowed = (over: Partial<ChannelChat>) => chat({ effective: { allowed: true, wake: 'always', delivery: 'final_text', retentionDays: 30 }, ...over });
	test('warns only when a policy needs more than mentions and the bot is no admin', () => {
		expect(privacyWarning(conn({ bot }), [allowed({ title: 'Ops' })])).toContain('Ops');
		expect(privacyWarning(conn({ bot }), [allowed({ botStatus: 'administrator' })])).toBeUndefined();
		expect(privacyWarning(conn({ bot }), [allowed({ kind: 'channel' })])).toBeUndefined();
		expect(privacyWarning(conn({ bot }), [chat({ effective: { allowed: true, wake: 'mention', delivery: 'final_text', retentionDays: 30 } })])).toBeUndefined();
		expect(privacyWarning(conn({ bot: { ...bot, canReadAllGroupMessages: true } }), [allowed({})])).toBeUndefined();
		expect(privacyWarning(conn(), [allowed({})])).toBeUndefined();
	});
});

describe('delivery and pairing text', () => {
	test('outbox and breaker', () => {
		expect(outboxSummary(conn())).toBe('Nothing waiting');
		expect(outboxSummary(conn({ counts: { chats: 0, linked: 0, outboxPending: 2, outboxFailed: 1 } }))).toBe('2 waiting to send · 1 failed');
		expect(breakerText(conn(), 0)).toBeUndefined();
		expect(breakerText(conn({ breaker: { open: true, until: 5 * 60_000, reason: 'forbidden' } }), 0)).toContain('about 5 min');
	});
	test('pairing validity', () => {
		expect(pairingText({ memberId: 'owner', link: 'x', command: '/start x', expiresAt: 24 * 3_600_000 }, 0)).toContain('24 hours');
	});
	test('agents and connections lists', () => {
		expect(agentChoices([{ id: '1', name: 'a' }, { id: '2', name: 'b', archivedAt: 5 }]).map((a) => a.id)).toEqual(['1']);
		const running = conn({ id: 'r', label: 'B', runtime: { state: 'running', since: 1 }, binding: { agentId: 'x', groupPolicy: 'allowlist', dm: 'pairing', allowBots: false, admins: [], historyLimit: 50, defaults: {} } });
		const loose = conn({ id: 'l', label: 'A', runtime: { state: 'unbound', since: 1 } });
		expect(sortConnections([loose, running]).map((c) => c.id)).toEqual(['r', 'l']);
	});
});
