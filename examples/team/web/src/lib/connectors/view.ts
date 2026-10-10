// Pure view helpers of the connectors UI: labels, badges, memory grouping. No raw tool names here.
import { connectionStatus, STATUS_BADGE } from '../config/status';
import type { Capability, CapabilityMode, Connection, Connector } from '../api/client';

export const KIND_LABEL: Record<Capability['kind'], string> = { read: 'Read', write: 'Write', destructive: 'Destructive', external: 'External' };
export const KIND_VARIANT: Record<Capability['kind'], 'secondary' | 'warning' | 'destructive' | 'info'> = {
	read: 'secondary',
	write: 'warning',
	destructive: 'destructive',
	external: 'info'
};

/** Icon names a connector may carry; the page maps them to components, unknown ones to `plugs`. */
export const KNOWN_ICONS = ['folder', 'brain', 'list-checks', 'globe', 'message-circle-question', 'users', 'github-logo', 'plugs'] as const;
export type IconKey = (typeof KNOWN_ICONS)[number];
export const iconKey = (name: string | undefined): IconKey => ((KNOWN_ICONS as readonly string[]).includes(name ?? '') ? (name as IconKey) : 'plugs');

export type StatusInfo = { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' };
export const statusInfo = (c: Pick<Connection, 'status' | 'enabled'>): StatusInfo => STATUS_BADGE[connectionStatus(c)] as StatusInfo;

/** "Whole workspace" or "Only <agent>". */
export function scopeLabel(c: Pick<Connection, 'scope' | 'scopeId'>, agentName: (id: string) => string | undefined): string {
	if (c.scope === 'agent') return `Only ${(c.scopeId && agentName(c.scopeId)) || 'one agent'}`;
	if (c.scope === 'user') return 'Only you';
	return 'Whole workspace';
}

/** The mode a capability has on a connection: its stored default, else the capability's own. */
export function modeOf(connection: Pick<Connection, 'defaultModes'>, cap: Pick<Capability, 'id' | 'defaultMode'>): CapabilityMode {
	return connection.defaultModes?.[cap.id] ?? cap.defaultMode;
}

/** Writes and destructive actions of a normal connector always ask, even in Bypass mode. */
export const alwaysAsks = (connector: Pick<Connector, 'builtin'>, cap: Pick<Capability, 'kind'>, mode: CapabilityMode): boolean =>
	!connector.builtin && mode === 'ask' && (cap.kind === 'write' || cap.kind === 'destructive');

/** The memory connector has one workspace connection and one per agent. */
export function splitMemory(connections: Connection[]): { workspace: Connection[]; agents: Connection[] } {
	return { workspace: connections.filter((c) => c.scope !== 'agent'), agents: connections.filter((c) => c.scope === 'agent') };
}

export const OAUTH_CLIENT_NEEDS_SETUP = (c: Connector): boolean => !!c.oauthClient?.required && !c.oauthClient.configured;
