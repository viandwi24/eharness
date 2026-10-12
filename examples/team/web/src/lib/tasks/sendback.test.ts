import { describe, expect, test } from 'bun:test';
import { manualWorker } from './sendback';

const program = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
	({ id, agentId: 'a1', status: 'active', worker: { claim: 1 }, trigger: { kind }, ...extra }) as never;

describe('manualWorker', () => {
	test('a manual worker of the agent is offered', () => {
		expect(manualWorker({ agentId: 'a1' }, [program('p1', 'manual')])?.id).toBe('p1');
	});
	test('a scheduled worker handles it: no Run now', () => {
		expect(manualWorker({ agentId: 'a1' }, [program('p1', 'manual'), program('p2', 'schedule')])).toBeNull();
	});
	test('other agents, paused and non-worker programs are ignored', () => {
		expect(manualWorker({ agentId: 'a1' }, [program('p1', 'manual', { agentId: 'a2' }), program('p2', 'manual', { status: 'paused' }), program('p3', 'manual', { worker: null })])).toBeNull();
	});
});
