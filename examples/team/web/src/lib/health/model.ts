// The Needs attention page's view model: health findings, consistency findings and alarms in one list. Pure.
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
	'order-hygiene': 'Standing order needs a look',
	consistency: 'Consistency'
};

/** What each consistency check says, as a short label (the `consistency.kind` of a finding). */
export const CONSISTENCY_LABEL: Record<string, string> = {
	'program-duplicate': 'Duplicate program',
	'program-needs-tool': 'Program needs a tool',
	'program-dead-ref': 'Program names something gone',
	'order-duplicates-note': 'Order repeats a program note',
	'routine-duplicate': 'Duplicate routine',
	'decision-stale': 'Decision waiting',
	'decision-dead-ref': 'Decision about something gone',
	'connection-used-but-broken': 'Connection in use is broken',
	'memory-dead-ref': 'Memory names something gone',
	'memory-duplicate-topic': 'Two memory files, one topic',
	'memory-placeholder': 'Memory placeholder',
	'memory-system-state': 'Memory states live system state'
};

export const isConsistency = (f: Pick<Finding, 'kind'>): boolean => f.kind === 'consistency';

/** "line 3 of status.md" for a memory finding, else null. */
export function memoryWhere(f: Pick<Finding, 'consistency'>): string | null {
	const c = f.consistency;
	if (!c?.memoryPath) return null;
	return c.line ? `${c.memoryPath}, line ${c.line}` : c.memoryPath;
}

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

export type Alarm = components['schemas']['Alarm'];

export const ALARM_LABEL: Record<Alarm['kind'], string> = {
	'run-failed': 'Run failed',
	'run-stuck': 'Run stopped (no activity)',
	'routine-paused': 'Routine paused',
	'approval-expired': 'Approval not answered',
	'connection-broken': 'Connection broken',
	system: 'Server step failed'
};

/** The button of an alarm: where its first ref leads (a run, the routines, the connectors). */
export function alarmAction(a: Pick<Alarm, 'refs'>): { href: string; label: string } | undefined {
	const href = a.refs[0];
	if (href === undefined) return undefined;
	if (href.startsWith('/tasks/')) return { href, label: 'Open the run' };
	if (href === '/connectors') return { href, label: 'Reconnect' };
	if (href.startsWith('/routines')) return { href, label: 'Open reminders' };
	if (href.startsWith('/programs/')) return { href, label: 'Open the program' };
	return { href, label: 'Open' };
}

/** How serious an alarm is, so it sorts among the findings (a failed run or a broken connection is high). */
export const ALARM_SEVERITY: Record<Alarm['kind'], Severity> = {
	'run-failed': 'high',
	'run-stuck': 'high',
	'routine-paused': 'medium',
	'approval-expired': 'medium',
	'connection-broken': 'high',
	system: 'medium'
};

/** One row of the page: a finding (health or consistency) or an alarm, with one way to dismiss it. */
export type AttentionItem =
	| { type: 'finding'; key: string; severity: Severity; at: number; finding: Finding }
	| { type: 'alarm'; key: string; severity: Severity; at: number; alarm: Alarm };

/** Findings and alarms as one list: high severity first, then the most recent. */
export function mergeAttention(findings: readonly Finding[], alarms: readonly Alarm[]): AttentionItem[] {
	const items: AttentionItem[] = [
		...findings.map((finding): AttentionItem => ({ type: 'finding', key: `f:${finding.fingerprint}`, severity: finding.severity, at: finding.lastSeen, finding })),
		...alarms.map((alarm): AttentionItem => ({ type: 'alarm', key: `a:${alarm.id}`, severity: ALARM_SEVERITY[alarm.kind], at: alarm.createdAt, alarm }))
	];
	return items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.at - a.at);
}

/** Open alarms count toward the severity totals of the filter menu. */
export function attentionCounts(findings: readonly Finding[], alarms: readonly Alarm[]): Record<Severity, number> {
	const out = severityCounts(findings);
	for (const a of alarms) out[ALARM_SEVERITY[a.kind]]++;
	return out;
}
