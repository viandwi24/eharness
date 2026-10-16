// The Health page's view model (agent health findings). Pure.
import type { components } from '../api/schema';

export type Finding = components['schemas']['HealthFinding'];
export type FindingKind = Finding['kind'];
export type Severity = Finding['severity'];

export const KIND_LABEL: Record<FindingKind, string> = {
	'repeated-denial': 'Denied again and again',
	'tool-loop': 'Tool loop',
	'repeated-error': 'Same error',
	'approval-waiting': 'Approval waiting',
	'token-spike': 'Context spike',
	'big-output': 'Oversized tool output',
	'program-run': 'Program run',
	'provider-error': 'Provider error',
	'tools-changed': 'Tools changed on the server',
	'order-hygiene': 'Standing order needs a look'
};

export const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export const SEVERITY_VARIANT: Record<Severity, 'destructive' | 'warning' | 'secondary'> = {
	high: 'destructive',
	medium: 'warning',
	low: 'secondary'
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** High severity first, then the problem seen most recently. */
export const sortFindings = (list: readonly Finding[]): Finding[] =>
	[...list].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.lastSeen - a.lastSeen);

/** Findings under the page filters (an empty filter means all). */
export function filterFindings(list: readonly Finding[], f: { agentId?: string; severity?: Severity | '' }): Finding[] {
	return list.filter((x) => (!f.agentId || x.agentId === f.agentId) && (!f.severity || x.severity === f.severity));
}

/** "3 times in 2h" style evidence line. */
export function seenLine(f: Pick<Finding, 'count' | 'firstSeen' | 'lastSeen'>, ago: (ms: number) => string): string {
	const times = f.count === 1 ? 'Seen once' : `Seen ${f.count} times`;
	return f.firstSeen === f.lastSeen ? `${times}, ${ago(f.lastSeen)} ago` : `${times}, first ${ago(f.firstSeen)} ago, last ${ago(f.lastSeen)} ago`;
}

/** Counts per severity of the findings that are not dismissed. */
export function severityCounts(list: readonly Finding[]): Record<Severity, number> {
	const out: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
	for (const f of list) if (!f.dismissed) out[f.severity]++;
	return out;
}
