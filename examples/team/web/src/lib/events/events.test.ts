import { describe, expect, test } from 'bun:test';
import { activeFilterCount, actorHandle, actorName, chatText, emptyFilters, factRows, filtersFromParams, groupCatalog, mergeFresh, paramsFromFilters, queryOf, sourceText, toggleType, typeLabel, windowOf, type EventTypeInfo, type StreamEvent } from './events';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const ev = (o: Partial<StreamEvent> = {}): StreamEvent => ({ id: 'ch:1', at: NOW, source: 'channel', sourceLabel: 'Ops bot', type: 'message.created', summary: 's', fields: {}, link: null, agentCaused: false, ...o });

describe('filters and the URL', () => {
	test('round trip keeps the non-default filters', () => {
		const f = { ...emptyFilters(), range: '7d' as const, source: 'channel' as const, types: ['message.created', 'reaction.added'], chat: 'ops', actor: '@ann' };
		const qs = paramsFromFilters(f).toString();
		expect(filtersFromParams(new URLSearchParams(qs))).toEqual(f);
		expect(paramsFromFilters(emptyFilters()).toString()).toBe('');
	});
	test('the open event is carried and unknown values are ignored', () => {
		expect(paramsFromFilters(emptyFilters(), 'ch:9').get('e')).toBe('ch:9');
		const f = filtersFromParams(new URLSearchParams('range=weird&source=x&type=a,,b'));
		expect(f.range).toBe('all');
		expect(f.source).toBe('');
		expect(f.types).toEqual(['a', 'b']);
	});
	test('a date without a range means custom', () => {
		expect(filtersFromParams(new URLSearchParams('from=2026-10-01')).range).toBe('custom');
	});
});

describe('query', () => {
	test('quick ranges anchor on now', () => {
		expect(windowOf({ ...emptyFilters(), range: '1h' }, NOW)).toEqual({ from: NOW - 3_600_000 });
		expect(windowOf({ ...emptyFilters(), range: '7d' }, NOW)).toEqual({ from: NOW - 7 * 86_400_000 });
		expect(windowOf(emptyFilters(), NOW)).toEqual({});
	});
	test('types are comma separated and empty text is dropped', () => {
		const q = queryOf({ ...emptyFilters(), types: ['a', 'b'], chat: ' ops ', actor: ' ', source: 'app' }, NOW);
		expect(q).toEqual({ type: 'a,b', chat: 'ops', source: 'app' });
	});
	test('the badge counts the filters besides the range', () => {
		expect(activeFilterCount(emptyFilters())).toBe(0);
		expect(activeFilterCount({ ...emptyFilters(), source: 'app', types: ['a'], actor: 'x' })).toBe(3);
	});
});

describe('catalog', () => {
	const types: EventTypeInfo[] = [
		{ type: 'task.changed', source: 'app', label: 'Task changed', fields: ['kind'] },
		{ type: 'message.created', source: 'channel', label: 'Message', fields: [] }
	];
	test('grouped by source, chat first', () => {
		const g = groupCatalog(types);
		expect(g.map((x) => x.source)).toEqual(['channel', 'app']);
		expect(groupCatalog([types[0]!]).map((x) => x.source)).toEqual(['app']);
	});
	test('labels and toggling', () => {
		expect(typeLabel(types, 'task.changed')).toBe('Task changed');
		expect(typeLabel(types, 'x.y')).toBe('x.y');
		expect(toggleType(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggleType(['a', 'b'], 'a')).toEqual(['b']);
	});
});

describe('words of a row', () => {
	test('source, chat and actor', () => {
		expect(sourceText(ev())).toBe('Ops bot');
		expect(sourceText(ev({ source: 'app', sourceLabel: 'app' }))).toBe('app');
		expect(chatText(ev())).toBe('');
		expect(chatText(ev({ chat: { nodeId: 'n', nativeId: '1', title: 'Ops' } }))).toBe('Ops');
		expect(actorName(ev())).toBe('');
		expect(actorName(ev({ actor: { name: 'Ann', username: 'ann' } }))).toBe('Ann');
		expect(actorHandle(ev({ actor: { name: 'Ann', username: 'ann' } }))).toBe('@ann');
		expect(actorName(ev({ actor: { username: 'ann' } }))).toBe('@ann');
		expect(actorName(ev({ actor: { id: '42' } }))).toBe('42');
		expect(actorName(ev({ actor: { self: true, name: 'Bot' } }))).toBe('the agent');
	});
	test('facts are sorted', () => {
		expect(factRows({ fields: { b: '2', a: '1' } })).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
	});
	test('a fresh page goes on top and keeps older loaded rows', () => {
		const fresh = [{ id: 'c', at: 30 }, { id: 'b', at: 20 }];
		const loaded = [{ id: 'b', at: 20 }, { id: 'a', at: 10 }, { id: 'z', at: 25 }];
		expect(mergeFresh(fresh, loaded).map((r) => r.id)).toEqual(['c', 'b', 'a']);
	});
});
