import { describe, expect, test } from 'bun:test';
import type { StreamEvent } from '../events/events';
import { actionText, bodyFromForm, capText, cooldownText, emptyForm, filteredHint, fireDetailRows, fireReasonText, fireVariant, formFromTrigger, generateSecret, listensText, parseList, prefillFromEvent, regexError, scopeText, sessionRoute, summaryText, validateForm, verdictLabel, type Trigger, type TriggerForm } from './triggers';

const trigger = (o: Partial<Trigger> = {}): Trigger => ({
	id: 't1',
	name: 'Watch',
	enabled: true,
	eventTypes: ['message.created'],
	scope: { connectionIds: [], chatIds: [] },
	filters: { actorRoles: [], actors: [], textContains: [], emoji: [], fields: [] },
	action: { kind: 'notify' },
	hasSecret: false,
	cooldownSec: 0,
	allowSelf: false,
	createdBy: 'owner',
	notes: null,
	createdAt: 1,
	updatedAt: 1,
	lastFiredAt: null,
	fireCount: 0,
	errorCount: 0,
	filteredCount: 0,
	...o
});
const form = (o: Partial<TriggerForm> = {}): TriggerForm => ({ ...emptyForm(), name: 'x', eventTypes: ['message.created'], ...o });
const ev = (o: Partial<StreamEvent> = {}): StreamEvent => ({ id: 'ch:1', at: 1, source: 'channel', sourceLabel: 'Ops', type: 'message.created', summary: 's', fields: {}, link: null, agentCaused: false, ...o });

describe('lists and regex', () => {
	test('parseList trims, splits and dedupes', () => {
		expect(parseList('a, b\n b ,,c')).toEqual(['a', 'b', 'c']);
	});
	test('regexError mirrors the server rules', () => {
		expect(regexError('')).toBeUndefined();
		expect(regexError('^deploy( now)?$')).toBeUndefined();
		expect(regexError('a'.repeat(201))).toContain('200');
		expect(regexError('(a+)+')).toContain('Nested');
		expect(regexError('(a)\\1')).toContain('Back');
		expect(regexError('(')).toContain('valid');
	});
});

describe('validation', () => {
	test('a complete notify trigger is valid', () => {
		expect(validateForm(form())).toEqual({});
	});
	test('name and event types are required', () => {
		const e = validateForm(form({ name: ' ', eventTypes: [] }));
		expect(e.name).toBeDefined();
		expect(e.eventTypes).toBeDefined();
	});
	test('a text filter needs a message type, an emoji filter a reaction type', () => {
		expect(validateForm(form({ eventTypes: ['task.changed'], textContains: ['x'] })).text).toBeDefined();
		expect(validateForm(form({ eventTypes: ['task.changed'], textRegex: 'x' })).text).toBeDefined();
		expect(validateForm(form({ textContains: ['x'] })).text).toBeUndefined();
		expect(validateForm(form({ emoji: ['x'] })).emoji).toBeDefined();
		expect(validateForm(form({ eventTypes: ['reaction.added'], emoji: ['x'] })).emoji).toBeUndefined();
	});
	test('wake needs an agent and an instruction, program a program', () => {
		expect(Object.keys(validateForm(form({ actionKind: 'wake' }))).sort()).toEqual(['agentId', 'instruction']);
		expect(validateForm(form({ actionKind: 'program' })).programId).toBeDefined();
	});
	test('a webhook needs https and a secret of 16+ unless one is stored', () => {
		expect(validateForm(form({ actionKind: 'webhook', url: 'http://x.io' })).url).toBeDefined();
		expect(validateForm(form({ actionKind: 'webhook', url: 'https://x.io' })).secret).toBeDefined();
		expect(validateForm(form({ actionKind: 'webhook', url: 'https://x.io', secret: 'short' })).secret).toBeDefined();
		expect(validateForm(form({ actionKind: 'webhook', url: 'https://x.io', secret: 'a'.repeat(16) }))).toEqual({});
		expect(validateForm(form({ actionKind: 'webhook', url: 'https://x.io' }), { editing: true, hadSecret: true })).toEqual({});
	});
	test('cooldown is a whole number of seconds', () => {
		expect(validateForm(form({ cooldownSec: '-1' })).cooldownSec).toBeDefined();
		expect(validateForm(form({ cooldownSec: '1.5' })).cooldownSec).toBeDefined();
		expect(validateForm(form({ cooldownSec: '' }))).toEqual({});
	});
	test('a half-filled field filter is an error', () => {
		expect(validateForm(form({ fields: [{ field: 'program', op: 'equals', value: '' }] })).fields).toBeDefined();
	});
});

describe('form and body', () => {
	test('body drops text filters without a message type and empty field rows', () => {
		const b = bodyFromForm(form({ eventTypes: ['task.changed'], textContains: ['x'], textRegex: 'y', emoji: ['z'], fields: [{ field: 'kind', op: 'contains', value: 'a' }, { field: '', op: 'equals', value: '' }] }));
		expect(b.filters).toEqual({ actorRoles: [], actors: [], textContains: [], emoji: [], fields: [{ field: 'kind', contains: 'a' }] });
	});
	test('body carries the action, cooldown and the secret only for a webhook when typed', () => {
		expect(bodyFromForm(form({ actionKind: 'wake', agentId: 'a1', instruction: ' go ', includeText: true, cooldownSec: '60' }))).toMatchObject({ action: { kind: 'wake', agentId: 'a1', target: 'triggers', instruction: 'go', includeText: true }, cooldownSec: 60 });
		expect(bodyFromForm(form({ actionKind: 'notify', secret: 'a'.repeat(20) })).webhookSecret).toBeUndefined();
		expect(bodyFromForm(form({ actionKind: 'webhook', url: 'https://x.io', secret: '' })).webhookSecret).toBeUndefined();
		expect(bodyFromForm(form({ actionKind: 'webhook', url: 'https://x.io', secret: 'a'.repeat(20) })).webhookSecret).toBe('a'.repeat(20));
		expect(bodyFromForm(form({ notes: ' ' })).notes).toBeNull();
	});
	test('formFromTrigger round trips through bodyFromForm', () => {
		const t = trigger({ eventTypes: ['message.created'], scope: { connectionIds: ['c1'], chatIds: ['n1'] }, filters: { actorRoles: ['admin'], actors: ['@ann'], textContains: ['deploy'], textRegex: '^go', emoji: [], fields: [{ field: 'k', equals: 'v' }] }, action: { kind: 'wake', agentId: 'a1', target: 'chat', instruction: 'do', includeText: false }, cooldownSec: 30, allowSelf: true, notes: 'n' });
		const b = bodyFromForm(formFromTrigger(t));
		expect(b).toMatchObject({ name: 'Watch', eventTypes: ['message.created'], scope: t.scope, filters: t.filters, action: t.action, cooldownSec: 30, allowSelf: true, notes: 'n' });
	});
	test('generateSecret is long enough and random', () => {
		const a = generateSecret();
		expect(a.length).toBeGreaterThanOrEqual(32);
		expect(a).not.toBe(generateSecret());
	});
});

describe('prefillFromEvent', () => {
	test('a channel event gives type, connection, chat room and person', () => {
		const p = prefillFromEvent(ev({ connectionId: 'c1', chat: { nodeId: 'n1', roomId: 'r1', nativeId: '9', title: 'Ops' }, actor: { id: '42', name: 'Ann' } }));
		expect(p).toEqual({ eventTypes: ['message.created'], connectionIds: ['c1'], chatIds: ['r1'], actors: ['42'] });
	});
	test('the chat node is used without a room, and the agent itself is not a filter', () => {
		const p = prefillFromEvent(ev({ connectionId: 'c1', chat: { nodeId: 'n1', nativeId: '9', title: 'Ops' }, actor: { id: '1', self: true } }));
		expect(p.chatIds).toEqual(['n1']);
		expect(p.actors).toBeUndefined();
	});
	test('an app event gives the most telling fact', () => {
		const p = prefillFromEvent(ev({ source: 'app', type: 'program.changed', fields: { status: 'failed', program: 'Weekly' } }));
		expect(p).toEqual({ eventTypes: ['program.changed'], fields: [{ field: 'program', op: 'equals', value: 'Weekly' }] });
		expect(prefillFromEvent(ev({ source: 'app', type: 'alarm.raised' })).fields).toBeUndefined();
	});
});

describe('sentences', () => {
	test('listens, scope, action and summary', () => {
		const t = trigger({ scope: { connectionIds: ['c1'], chatIds: ['a', 'b', 'c'] }, filters: { actorRoles: ['admin', 'owner'], actors: [], textContains: ['deploy'], emoji: [], fields: [{ field: 'kind', equals: 'x' }] }, action: { kind: 'wake', agentId: 'a1', target: 'triggers', instruction: 'go' } });
		const names = { connection: () => 'Ops bot', agent: () => 'Ada', typeLabel: () => 'Message' };
		expect(listensText(t, names)).toBe('Listens to Message');
		expect(scopeText(t, names)).toBe('on Ops bot, in 3 chats');
		expect(scopeText(trigger())).toBe('anywhere');
		expect(actionText(t, names)).toBe('wakes Ada in the Triggers chat');
		expect(actionText(trigger({ action: { kind: 'webhook', url: 'https://hooks.example.com/x' } }))).toBe('calls hooks.example.com');
		expect(summaryText(t, names)).toBe('Listens to Message on Ops bot, in 3 chats, by admin or owner, text has "deploy", kind is x; wakes Ada in the Triggers chat.');
	});
	test('cap, cooldown, hint', () => {
		expect(capText(3, 60)).toBe('3 firings in the last hour of at most 60');
		expect(capText(1, 0)).toBe('1 firing in the last hour, no cap');
		expect(cooldownText(0)).toBe('none');
		expect(cooldownText(300)).toBe('5 minutes');
		expect(cooldownText(7200)).toBe('2 hours');
		expect(cooldownText(45)).toBe('45 seconds');
		expect(filteredHint(0)).toBe('');
		expect(filteredHint(1)).toContain('1 non-matching message ');
	});
});

describe('firings', () => {
	test('result words and variants', () => {
		expect(fireVariant('ok')).toBe('success');
		expect(fireVariant('skipped')).toBe('secondary');
		expect(fireVariant('error')).toBe('destructive');
		expect(fireReasonText({ result: 'skipped', reason: 'cooldown' })).toContain('cooldown');
		expect(fireReasonText({ result: 'skipped', reason: 'weird' })).toBe('weird');
		expect(fireReasonText({ result: 'error', reason: 'http_500' })).toBe('http_500');
		expect(fireReasonText({ result: 'ok', reason: null })).toBe('');
	});
	test('detail rows keep plain values only', () => {
		expect(fireDetailRows({ sessionId: 's', status: 200, nested: { a: 1 }, error: '', n: null })).toEqual([
			{ key: 'sessionId', label: 'session', value: 's' },
			{ key: 'status', label: 'HTTP status', value: '200' }
		]);
	});
	test('session routes only for web chats', () => {
		expect(sessionRoute('dm:a1')).toBe('/a/a1');
		expect(sessionRoute('chat:a1:t1')).toBe('/a/a1?t=chat%3Aa1%3At1');
		expect(sessionRoute('other:x')).toBeUndefined();
	});
	test('verdict words', () => {
		expect(verdictLabel('fire')).toBe('Would fire');
		expect(verdictLabel('skip', 'cooldown')).toBe('Would skip: cooldown');
		expect(verdictLabel('nomatch', 'wrong chat')).toBe('Does not match: wrong chat');
	});
});
