// Pure logic of "who uses this account": one concept per connection (All agents / Selected agents),
// the summaries the directory shows, the "By agent" view and the optimistic update of a change.
import type { Agent, Connection, ConnectionAccess, ConnectionAccessPut } from '../api/client';

export const ACCESS_LABEL = { all: 'All agents', selected: 'Selected agents' } as const;

/** The connection's access, with a safe default for one the server did not describe. */
export const accessOf = (c: Pick<Connection, 'access' | 'scope' | 'scopeId' | 'defaultEnabled'>): ConnectionAccess =>
	c.access ?? (c.scope === 'agent' ? { mode: 'selected', agentIds: c.scopeId ? [c.scopeId] : [], excludedAgentIds: [] } : { mode: c.defaultEnabled ? 'all' : 'selected', agentIds: [], excludedAgentIds: [] });

/** Agents that use the connection now, in the order of the agent list (archived ones are gone). */
export function usersOf(c: Connection, agents: Agent[]): Agent[] {
	const ids = new Set(accessOf(c).agentIds);
	return agents.filter((a) => ids.has(a.id));
}

export const excludedOf = (c: Connection, agents: Agent[]): Agent[] => {
	const ids = new Set(accessOf(c).excludedAgentIds);
	return agents.filter((a) => ids.has(a.id));
};

/** "All agents", "Writer", "Writer, Coder", "3 agents" or "Not used by any agent yet". */
export function usageText(c: Connection, agents: Agent[]): string {
	const a = accessOf(c);
	if (a.mode === 'all') return a.excludedAgentIds.length ? `All agents except ${a.excludedAgentIds.length}` : 'All agents';
	const users = usersOf(c, agents);
	if (users.length === 0) return 'Not used by any agent yet';
	if (users.length <= 2) return users.map((u) => u.name).join(', ');
	return `${users.length} agents`;
}

/** "2 accounts · used by 3 agents" for a directory card. */
export function cardUsage(connections: Connection[], agents: Agent[]): string {
	const accounts = `${connections.length} ${connections.length === 1 ? 'account' : 'accounts'}`;
	const ids = new Set<string>();
	for (const c of connections) for (const u of usersOf(c, agents)) ids.add(u.id);
	return ids.size === 0 ? `${accounts} · not used yet` : `${accounts} · used by ${ids.size} ${ids.size === 1 ? 'agent' : 'agents'}`;
}

/** The distinct agents using any of these connections. */
export function distinctUsers(connections: Connection[], agents: Agent[]): Agent[] {
	const ids = new Set<string>();
	for (const c of connections) for (const u of usersOf(c, agents)) ids.add(u.id);
	return agents.filter((a) => ids.has(a.id));
}

/** The non-built-in accounts one agent uses (the "By agent" chips). */
export const accountsOfAgent = (agentId: string, connections: Connection[]): Connection[] =>
	connections.filter((c) => !c.builtin && accessOf(c).agentIds.includes(agentId));

/** The label of an account for a chip or a list row: "GitHub · work" or just its name. */
export function accountName(c: Connection, connectorName?: string): string {
	if (c.custom || !connectorName) return c.label;
	return c.label && c.label !== connectorName ? `${connectorName} · ${c.label}` : (c.accountLabel ? `${connectorName} · ${c.accountLabel}` : connectorName);
}

/** The request for a change of the mode or of the selection. */
export const putFor = (mode: 'all' | 'selected', agentIds: string[]): ConnectionAccessPut => (mode === 'all' ? { mode } : { mode, agentIds });

export function toggleAgent(agentIds: string[], agentId: string): string[] {
	return agentIds.includes(agentId) ? agentIds.filter((id) => id !== agentId) : [...agentIds, agentId];
}

/** Optimistic copy of a connection for a change (the server's answer replaces it). */
export function applyAccess(c: Connection, input: ConnectionAccessPut, allAgentIds: string[]): Connection {
	const current = accessOf(c);
	if (input.mode === 'all') {
		const excluded = (input.excludedAgentIds ?? (current.mode === 'all' ? current.excludedAgentIds : [])).filter((id) => allAgentIds.includes(id));
		return { ...c, scope: 'workspace', scopeId: undefined, defaultEnabled: true, access: { mode: 'all', excludedAgentIds: excluded, agentIds: allAgentIds.filter((id) => !excluded.includes(id)) } };
	}
	const chosen = [...new Set(input.agentIds ?? [])].filter((id) => allAgentIds.includes(id));
	return { ...c, scope: 'workspace', scopeId: undefined, defaultEnabled: false, access: { mode: 'selected', agentIds: chosen, excludedAgentIds: [] } };
}

/** Filter agents by a search box (name or slug). */
export function matchAgents(agents: Agent[], query: string): Agent[] {
	const q = query.trim().toLowerCase();
	return q === '' ? agents : agents.filter((a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q));
}
