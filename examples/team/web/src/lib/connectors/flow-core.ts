// The state machine of one connect flow in the browser (framework-free). The server drives the
// flow: it answers with a `view` of a closed vocabulary and every action quotes the `viewId` it
// answers. A stale view (double submit, another tab) is a 409 that carries the current flow: the
// session adopts it and nothing is lost. A finished flow carries the saved `connection`.
import { ApiError, type ApiClient, type ConnectFlow, type Connection, type FlowResult, type FlowView } from '../api/client';

export type FlowStart = {
	/** A new connection of this connector. */
	definitionId?: string;
	/** Or re-authorize this connection. */
	connectionId?: string;
	scope?: 'workspace' | 'agent';
	/** The agent (agent scope). */
	scopeId?: string;
	label?: string;
	/** Workspace scope: available to all agents. */
	defaultEnabled?: boolean;
};

export type FlowAction = 'submit' | 'poll' | 'back' | 'cancel' | 'retry';

export type FlowSessionState = {
	flow: ConnectFlow | null;
	/** Set once the flow finished and the connection was saved. */
	connection: Connection | null;
	/** A request is in flight (disable the buttons; not set while polling). */
	busy: boolean;
	/** A transport or unexpected error (not a flow `error` view). */
	error: string | null;
};

export const emptyFlowSession = (): FlowSessionState => ({ flow: null, connection: null, busy: false, error: null });

/** Whether the view wants to be polled, and how often (ms). */
export function pollIntervalOf(view: FlowView | undefined): number | null {
	if (view?.type === 'oauth' || view?.type === 'deviceCode') return Math.max(1000, view.pollIntervalMs);
	return null;
}

export const isFinished = (flow: ConnectFlow | null): boolean => flow !== null && flow.status !== 'active';

export function createFlowSession(api: ApiClient, state: FlowSessionState) {
	const adopt = (r: FlowResult): void => {
		state.flow = r.flow;
		if (r.connection) state.connection = r.connection;
	};

	/** A 409 of the act route carries the current flow: adopt it; anything else is an error message. */
	function onFailure(e: unknown): void {
		if (e instanceof ApiError && e.status === 409) {
			const body = e.body as { flow?: ConnectFlow; connection?: Connection } | undefined;
			if (body?.flow) {
				state.flow = body.flow;
				if (body.connection) state.connection = body.connection;
				// a stale view is silent (the fresh view is shown); an expired flow says so
				state.error = e.code === 'FLOW_EXPIRED' ? e.message : null;
				return;
			}
		}
		state.error = e instanceof Error ? e.message : String(e);
	}

	const session = {
		state,

		async start(input: FlowStart): Promise<void> {
			state.busy = true;
			state.error = null;
			state.connection = null;
			try {
				adopt(await api.post('/connections/flows', { body: input }));
			} catch (e) {
				onFailure(e);
			} finally {
				state.busy = false;
			}
		},

		/** Pick a flow up again (the OAuth redirect back to `/connectors?flow=<id>`, a reload). */
		async resume(flowId: string): Promise<void> {
			state.busy = true;
			state.error = null;
			try {
				adopt(await api.get('/connections/flows/{id}', { params: { id: flowId } }));
			} catch (e) {
				state.error = e instanceof ApiError && e.status === 404 ? 'This connection attempt expired. Start again.' : e instanceof Error ? e.message : String(e);
			} finally {
				state.busy = false;
			}
		},

		/** Answer the current view. `silent` (polls) leaves `busy` alone. */
		async act(action: FlowAction, data?: Record<string, unknown>, o: { silent?: boolean } = {}): Promise<void> {
			const flow = state.flow;
			if (!flow || state.busy) return;
			if (!o.silent) state.busy = true;
			if (!o.silent) state.error = null;
			try {
				adopt(
					await api.post('/connections/flows/{id}/act', {
						params: { id: flow.id },
						body: { viewId: flow.view.viewId, action, ...(data === undefined ? {} : { data }) }
					})
				);
			} catch (e) {
				onFailure(e);
			} finally {
				if (!o.silent) state.busy = false;
			}
		},

		/** Poll once (OAuth / device code views). */
		poll: (): Promise<void> => session.act('poll', undefined, { silent: true }),

		reset(): void {
			state.flow = null;
			state.connection = null;
			state.busy = false;
			state.error = null;
		}
	};
	return session;
}

export type FlowSession = ReturnType<typeof createFlowSession>;
