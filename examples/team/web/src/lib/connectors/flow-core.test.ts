import { describe, expect, test } from 'bun:test';
import { ApiError, type ApiClient, type ConnectFlow, type Connection, type FlowView } from '../api/client';
import { createFlowSession, emptyFlowSession, pollIntervalOf } from './flow-core';

const view = (viewId: string, over: Partial<FlowView> = {}): FlowView => ({ type: 'confirm', viewId, step: 's', title: 't', message: 'm', confirmLabel: 'Yes', cancelLabel: 'No', ...over }) as FlowView;
const flow = (v: FlowView, status: ConnectFlow['status'] = 'active'): ConnectFlow => ({ id: 'f1', definitionId: 'd', scope: 'workspace', label: 'L', status, step: 's', rev: 1, view: v, createdAt: 0, updatedAt: 0, expiresAt: 0 });
const connection = { id: 'c1', label: 'L' } as Connection;

type Call = { kind: 'get' | 'post'; path: string; opts: any };
function fake(handler: (c: Call) => unknown) {
	const calls: Call[] = [];
	const run = (kind: 'get' | 'post') => async (path: string, opts: any) => {
		const c = { kind, path, opts };
		calls.push(c);
		const r = handler(c);
		if (r instanceof Error) throw r;
		return r;
	};
	return { api: { get: run('get'), post: run('post') } as unknown as ApiClient, calls };
}

describe('flow session', () => {
	test('start adopts the first view', async () => {
		const { api, calls } = fake(() => ({ flow: flow(view('v1')) }));
		const s = createFlowSession(api, emptyFlowSession());
		await s.start({ definitionId: 'd' });
		expect(s.state.flow?.view.viewId).toBe('v1');
		expect(s.state.busy).toBe(false);
		expect(calls[0]?.path).toBe('/connections/flows');
	});

	test('act quotes the view id and the data', async () => {
		const { api, calls } = fake((c) => (c.path.endsWith('/act') ? { flow: flow(view('v2')) } : { flow: flow(view('v1')) }));
		const s = createFlowSession(api, emptyFlowSession());
		await s.start({ definitionId: 'd' });
		await s.act('submit', { a: 1 });
		expect(calls[1]?.opts.body).toEqual({ viewId: 'v1', action: 'submit', data: { a: 1 } });
		expect(s.state.flow?.view.viewId).toBe('v2');
	});

	test('a stale view (409) adopts the current flow silently', async () => {
		let n = 0;
		const { api } = fake(() => (n++ === 0 ? { flow: flow(view('v1')) } : Object.assign(new ApiError(409, 'STALE_VIEW', 'stale'), { body: { flow: flow(view('v9')) } })));
		const s = createFlowSession(api, emptyFlowSession());
		await s.start({ definitionId: 'd' });
		await s.act('submit');
		expect(s.state.flow?.view.viewId).toBe('v9');
		expect(s.state.error).toBeNull();
	});

	test('an expired flow sets the error', async () => {
		let n = 0;
		const { api } = fake(() => (n++ === 0 ? { flow: flow(view('v1')) } : Object.assign(new ApiError(409, 'FLOW_EXPIRED', 'This attempt expired'), { body: { flow: flow(view('v1'), 'failed') } })));
		const s = createFlowSession(api, emptyFlowSession());
		await s.start({ definitionId: 'd' });
		await s.act('poll');
		expect(s.state.error).toBe('This attempt expired');
		expect(s.state.flow?.status).toBe('failed');
	});

	test('resume 404 says the attempt expired', async () => {
		const { api } = fake(() => new ApiError(404, 'NOT_FOUND', 'nope'));
		const s = createFlowSession(api, emptyFlowSession());
		await s.resume('x');
		expect(s.state.error).toBe('This connection attempt expired. Start again.');
		expect(s.state.flow).toBeNull();
	});

	test('a finished flow carries the connection', async () => {
		let n = 0;
		const { api } = fake(() => (n++ === 0 ? { flow: flow(view('v1')) } : { flow: flow(view('v2', { type: 'status' } as never), 'done'), connection }));
		const s = createFlowSession(api, emptyFlowSession());
		await s.start({ definitionId: 'd' });
		await s.act('submit');
		expect(s.state.connection?.id).toBe('c1');
		expect(s.state.flow?.status).toBe('done');
	});

	test('poll interval only for waiting views', () => {
		expect(pollIntervalOf(view('v'))).toBeNull();
		expect(pollIntervalOf({ type: 'oauth', viewId: 'v', step: 's', title: 't', authorizeUrl: 'u', pollIntervalMs: 200, expiresAt: 0 })).toBe(1000);
	});
});
