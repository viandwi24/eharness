// The memory reorganization flow: the rows the owner edits <-> the API shapes. Pure.
import type { components } from '../api/schema';

export type ReorgRow = components['schemas']['MemoryReorgRow'];
export type ReorgPlan = components['schemas']['MemoryReorgPlan'];
export type ReorgPlanRow = components['schemas']['MemoryReorgPlanRow'];
export type ReorgAction = ReorgRow['action'];

export const REORG_ACTIONS: { value: ReorgAction; label: string; hint: string }[] = [
	{ value: 'keep-as-rule', label: 'Keep as a rule', hint: 'Merged into rules.md' },
	{ value: 'move', label: 'Move to the library', hint: 'A new file under /library' },
	{ value: 'merge-into', label: 'Merge into another file', hint: 'Added to a file that moves' },
	{ value: 'archive', label: 'Archive', hint: 'Stale: kept in /library/archive/memory' }
];

export const actionLabel = (a: ReorgAction): string => REORG_ACTIONS.find((x) => x.value === a)?.label ?? a;

/** The editable part of a plan: what the owner changes and sends back. */
export const rowsOf = (plan: Pick<ReorgPlan, 'rows'>): ReorgRow[] =>
	plan.rows.map((r) => ({ source: r.source, action: r.action, target: r.target, reason: r.reason }));

/** Change one row's action; a move keeps its library path, anything else has no free target. */
export function setAction(rows: readonly ReorgRow[], source: string, action: ReorgAction): ReorgRow[] {
	return rows.map((r) => {
		if (r.source !== source) return r;
		const keepTarget = action === r.action ? r.target : null;
		const target =
			action === 'move' ? (keepTarget ?? `/library/knowledge/${source.split('/').pop() ?? source}`) : action === 'merge-into' ? keepTarget : null;
		return { ...r, action, target };
	});
}

export const setTarget = (rows: readonly ReorgRow[], source: string, target: string): ReorgRow[] =>
	rows.map((r) => (r.source === source ? { ...r, target: target.trim() === '' ? null : target.trim() } : r));

/** Where the content ends up, in words. */
export function destinationText(row: Pick<ReorgPlanRow, 'finalTarget' | 'action'>): string {
	if (row.finalTarget.startsWith('memory:')) return row.finalTarget.slice('memory:'.length);
	return row.finalTarget === '' ? 'no valid place yet' : row.finalTarget;
}

export const errorsOf = (plan: Pick<ReorgPlan, 'issues'>, source?: string) =>
	plan.issues.filter((i) => i.level === 'error' && (source === undefined || i.source === source));
export const notesOf = (plan: Pick<ReorgPlan, 'issues'>, source: string) =>
	plan.issues.filter((i) => i.level === 'note' && i.source === source);

/** One line for the result of an apply. */
export function resultText(r: { counts: { added: number; changed: number; removed: number; failed: number } }): string {
	const moved = r.counts.removed;
	const parts = [`${r.counts.added} library file${r.counts.added === 1 ? '' : 's'} written`, `${moved} original${moved === 1 ? '' : 's'} moved to the archive`];
	if (r.counts.changed) parts.push(`${r.counts.changed} rewritten`);
	if (r.counts.failed) parts.push(`${r.counts.failed} failed (those files stay in memory)`);
	return `${parts.join(', ')}.`;
}
