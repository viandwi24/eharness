// Pure logic of the composer tools menu: which connectors this chat offers, and the PUT body of a switch.
import type { components } from '../api/schema';

export type ChatTools = components['schemas']['ChatTools'];
export type ChatToolConnector = ChatTools['connectors'][number];

/** Connection ids switched off in this chat. */
export const offIds = (s: Pick<ChatTools, 'connectors'>): string[] => s.connectors.filter((c) => !c.on).map((c) => c.connectionId);

/** The `off` list after switching one connection; the rest keep their state. */
export function withSwitch(s: Pick<ChatTools, 'connectors'>, connectionId: string, on: boolean): string[] {
	const off = new Set(offIds(s));
	if (on) off.delete(connectionId);
	else off.add(connectionId);
	return [...off];
}

/** The state as it looks after a switch (optimistic update before the server answers). */
export function applySwitch(s: ChatTools, connectionId: string, on: boolean): ChatTools {
	const connectors = s.connectors.map((c) => (c.connectionId === connectionId ? { ...c, on } : c));
	return { connectors, offCount: connectors.filter((c) => !c.on).length };
}

/** The web search switch gets its own row (Claude and ChatGPT show it as a quick toggle). */
export const isWeb = (c: Pick<ChatToolConnector, 'connectorId'>): boolean => c.connectorId === 'web';

/** The rows of the menu: web search first, then the connectors by name. */
export function menuRows(s: Pick<ChatTools, 'connectors'>): { web: ChatToolConnector[]; others: ChatToolConnector[] } {
	return {
		web: s.connectors.filter(isWeb),
		others: s.connectors.filter((c) => !isWeb(c)).sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label))
	};
}

/** Count on the menu button: how many are off, or nothing when all are on. */
export const offBadge = (s: Pick<ChatTools, 'offCount'> | undefined): string | undefined => (s && s.offCount > 0 ? String(s.offCount) : undefined);

/** A line under the connector name: its account, else its label when it differs from the name. */
export function subtitle(c: Pick<ChatToolConnector, 'name' | 'label' | 'accountLabel' | 'status'>): string {
	if (c.status === 'needs-auth') return 'Needs sign-in';
	if (c.status === 'error') return 'Connection problem';
	if (c.accountLabel) return c.accountLabel;
	return c.label !== c.name ? c.label : '';
}
