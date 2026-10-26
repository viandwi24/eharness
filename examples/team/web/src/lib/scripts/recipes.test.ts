import { describe, expect, test } from 'bun:test';
import { missingFields, RECIPES } from './recipes';

const recipe = (id: string) => RECIPES.find((r) => r.id === id)!;

describe('recipes', () => {
	test('forward: the manifest grants exactly the target chat', () => {
		const r = recipe('forward');
		const out = r.build({ from: { connection: 'c1', chat: 'Ops' }, words: ['halo'], to: { connection: 'c1', chat: 'VIP' } });
		expect(out.manifest).toEqual({
			triggers: [{ kind: 'channel', events: ['message.created'], connections: ['c1'], chats: ['Ops'], textContains: ['halo'] }],
			grants: { send: [{ connection: 'c1', chat: 'VIP' }] }
		});
		expect(out.source).toContain('chat: "VIP"');
		expect(out.source).toContain('export default async function');
	});

	test('report: a daily cron and the folder grant', () => {
		const out = recipe('report').build({ table: 'orders', time: '07:30', folder: '/library/reports/' });
		expect(out.manifest).toEqual({
			triggers: [{ kind: 'schedule', spec: { kind: 'cron', expr: '30 7 * * *' } }],
			grants: { tablesRead: ['orders'], libraryWrite: ['/library/reports/**'] }
		});
	});

	test('missing fields name what to fill', () => {
		expect(missingFields(recipe('forward'), {})).toEqual(['From chat', 'To chat']);
		expect(missingFields(recipe('forward'), { from: { connection: 'c1', chat: 'A' }, to: { connection: 'c1', chat: 'B' } })).toEqual([]);
		expect(missingFields(recipe('blank'), {})).toEqual([]);
	});

	test('every recipe builds valid-looking output with empty values', () => {
		for (const r of RECIPES) {
			const out = r.build({});
			expect(out.source).toContain('export default');
			expect(Array.isArray(out.manifest.triggers)).toBe(true);
		}
	});
});
