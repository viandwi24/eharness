// Pure logic of the agent "Connectors" tab: grouping, labels and the PUT bodies for each change.
import type { AgentConnector, CapabilityMode, ConnectionChoices } from '../api/client';

export const originLabel = (c: Pick<AgentConnector, 'ownership'>): string => (c.ownership === 'workspace' ? 'From workspace' : 'This agent only');

/** Short badge for the built-in Memory scopes, else the generic origin. */
export function scopeBadge(c: Pick<AgentConnector, 'ownership' | 'source'>): string {
	if (c.source === 'builtin') return c.ownership === 'workspace' ? 'Whole team' : 'Only this agent';
	return originLabel(c);
}

export function groupConnectors(list: AgentConnector[]): { builtin: AgentConnector[]; connected: AgentConnector[] } {
	return { builtin: list.filter((c) => c.source === 'builtin'), connected: list.filter((c) => c.source !== 'builtin') };
}

/** Workspace connections that exist but are not enabled for this agent. */
export const availableToAdd = (list: AgentConnector[]): AgentConnector[] => list.filter((c) => !c.enabled);

/** The full choices of a connection as the view shows them (what a PUT must keep). */
export function choicesOf(c: AgentConnector): ConnectionChoices {
	const capabilities: Record<string, CapabilityMode> = {};
	const tools: Record<string, CapabilityMode> = {};
	for (const cap of c.capabilities) {
		if (cap.override) capabilities[cap.id] = cap.override;
		for (const t of cap.toolModes) if (t.override) tools[t.name] = t.override;
	}
	return {
		...(c.state !== 'inherit' ? { enabled: c.state } : {}),
		...(Object.keys(capabilities).length ? { capabilities } : {}),
		...(Object.keys(tools).length ? { tools } : {})
	};
}

export const withEnabled = (c: AgentConnector, on: boolean): ConnectionChoices => ({ ...choicesOf(c), enabled: on ? 'on' : 'off' });

function withRecord(c: AgentConnector, key: 'capabilities' | 'tools', id: string, mode: CapabilityMode | null): ConnectionChoices {
	const base = choicesOf(c);
	const next = { ...(base[key] ?? {}) };
	if (mode === null) delete next[id];
	else next[id] = mode;
	const { [key]: _drop, ...rest } = base;
	return Object.keys(next).length ? { ...rest, [key]: next } : rest;
}

/** `mode: null` clears the override (back to the default). */
export const withCapabilityMode = (c: AgentConnector, capabilityId: string, mode: CapabilityMode | null): ConnectionChoices => withRecord(c, 'capabilities', capabilityId, mode);
export const withToolMode = (c: AgentConnector, tool: string, mode: CapabilityMode | null): ConnectionChoices => withRecord(c, 'tools', tool, mode);

/** Optimistic copy of the view for a change (the server's answer replaces it). */
export function applyChoices(c: AgentConnector, choices: ConnectionChoices | null): AgentConnector {
	const state = choices?.enabled ?? 'inherit';
	const enabled = state === 'on' ? true : state === 'off' ? false : c.ownership === 'agent' || c.defaultEnabled;
	return {
		...c,
		state,
		enabled,
		capabilities: c.capabilities.map((cap) => {
			const override = choices?.capabilities?.[cap.id];
			const toolModes = cap.toolModes.map((t) => {
				const o = choices?.tools?.[t.name];
				return { ...t, override: o, mode: o ?? override ?? cap.inherited };
			});
			return { ...cap, override, mode: override ?? cap.inherited, toolModes };
		})
	};
}
