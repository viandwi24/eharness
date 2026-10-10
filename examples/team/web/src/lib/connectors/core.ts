// Connectors store logic: the catalog (`GET /connectors`), the connections (`GET /connections`) and
// the per-agent view (`GET /agents/{id}/connectors`). Framework-free: the `.svelte.ts` wrapper hands
// it a reactive state object. Plain words only: capability titles, never tool names, except under
// the "Advanced" disclosure of a connection.
import type { AgentConnector, ApiClient, Capability, CapabilityMode, Connection, ConnectionChoices, Connector } from '../api/client';

export type ConnectorsState = {
	connectors: Connector[];
	connections: Connection[];
	loaded: boolean;
	error: string | null;
};

export const emptyConnectorsState = (): ConnectorsState => ({ connectors: [], connections: [], loaded: false, error: null });

/** Words for the three capability modes. */
export const MODE_LABEL: Record<CapabilityMode, string> = { allow: 'Allowed', ask: 'Ask first', off: 'Off' };
export const MODES: CapabilityMode[] = ['allow', 'ask', 'off'];

/** The capabilities of a connection: the ones discovered at connect time, else the connector's. */
export function capabilitiesOf(connector: Connector | undefined, connection: Connection | undefined): Capability[] {
	return connection?.capabilities?.length ? connection.capabilities : (connector?.capabilities ?? []);
}

export const CATEGORY_LABEL: Record<string, string> = {
	workspace: 'Workspace',
	development: 'Development',
	custom: 'Custom'
};
export const categoryLabel = (id: string): string => CATEGORY_LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Connector cards of the directory, grouped like Claude: connected, available, included. */
export type DirectorySections = { connected: Connector[]; available: Connector[]; included: Connector[] };

export function matchesQuery(c: Connector, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
}

export function directorySections(
	connectors: Connector[],
	connections: Connection[],
	filter: { query?: string; category?: string | null } = {}
): DirectorySections {
	const out: DirectorySections = { connected: [], available: [], included: [] };
	for (const c of connectors) {
		if (!matchesQuery(c, filter.query ?? '')) continue;
		if (filter.category && c.category !== filter.category) continue;
		if (c.builtin) out.included.push(c);
		else if (connections.some((x) => x.definitionId === c.id)) out.connected.push(c);
		else out.available.push(c);
	}
	return out;
}

/** The categories present in the catalog, built-ins first. */
export function categoriesOf(connectors: Connector[]): string[] {
	return [...new Set(connectors.map((c) => c.category))];
}

export function createConnectorsCore(api: ApiClient, state: ConnectorsState) {
	let seq = 0;
	const core = {
		state,

		async load(): Promise<void> {
			const mine = ++seq;
			try {
				const [catalog, conns] = await Promise.all([api.get('/connectors'), api.get('/connections')]);
				if (mine !== seq) return;
				state.connectors = catalog.connectors;
				state.connections = conns.connections;
				state.loaded = true;
				state.error = null;
			} catch (e) {
				if (mine === seq) state.error = e instanceof Error ? e.message : String(e);
			}
		},

		connector(id: string): Connector | undefined {
			return state.connectors.find((c) => c.id === id);
		},

		connection(id: string): Connection | undefined {
			return state.connections.find((c) => c.id === id);
		},

		/** Connections of one connector (workspace and agent scoped). */
		connectionsOf(definitionId: string): Connection[] {
			return state.connections.filter((c) => c.definitionId === definitionId);
		},

		async update(id: string, patch: components_ConnectionPatch): Promise<Connection> {
			const next = await api.patch('/connections/{id}', { params: { id }, body: patch });
			state.connections = state.connections.map((c) => (c.id === id ? next : c));
			return next;
		},

		async remove(id: string): Promise<void> {
			await api.delete('/connections/{id}', { params: { id } });
			state.connections = state.connections.filter((c) => c.id !== id);
		},

		async test(id: string) {
			const res = await api.post('/connections/{id}/test', { params: { id } });
			state.connections = state.connections.map((c) => (c.id === id ? res.connection : c));
			return res;
		},

		/** Save the OAuth app credentials of a connector (admin), then reload the catalog. */
		async saveOAuthClient(definitionId: string, clientId: string, clientSecret?: string): Promise<void> {
			await api.put('/connectors/{id}/oauth-client', { params: { id: definitionId }, body: { clientId, ...(clientSecret ? { clientSecret } : {}) } });
			await core.load();
		},

		// --- one agent ----------------------------------------------------------------------

		agentConnectors(agentId: string): Promise<AgentConnector[]> {
			return api.get('/agents/{id}/connectors', { params: { id: agentId } }).then((r) => r.connectors);
		},

		/** Replace the agent's choices for some connections (`null` = back to inherit). */
		setAgentConnectors(agentId: string, connections: Record<string, ConnectionChoices | null>): Promise<AgentConnector[]> {
			return api.put('/agents/{id}/connectors', { params: { id: agentId }, body: { connections } as never }).then((r) => r.connectors);
		}
	};
	return core;
}

type components_ConnectionPatch = import('../api/schema').components['schemas']['ConnectionPatch'];

export type ConnectorsStore = ReturnType<typeof createConnectorsCore>;
