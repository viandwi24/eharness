// Groups the pending items of one chat for the dock above the composer. Parallel approvals of the
// same tool (same session) become ONE card; everything else stays a single card in the pager.
// Pure, unit-tested.
import type { Approval } from '../api/client.js';

export type PendingEntry = { kind: 'single'; item: Approval } | { kind: 'group'; toolName: string; items: Approval[] };

/** Entry order follows the first member of each group; items keep their list order. */
export function groupPending(items: readonly Approval[]): PendingEntry[] {
	const out: PendingEntry[] = [];
	const groups = new Map<string, Extract<PendingEntry, { kind: 'group' }>>();
	const firstOf = new Map<string, number>();
	items.forEach((a, i) => {
		if (a.kind !== 'approval') return;
		const key = `${a.sessionId}\u0000${a.toolName}`;
		if (!firstOf.has(key)) firstOf.set(key, i);
	});
	const count = new Map<string, number>();
	for (const a of items) {
		if (a.kind !== 'approval') continue;
		const key = `${a.sessionId}\u0000${a.toolName}`;
		count.set(key, (count.get(key) ?? 0) + 1);
	}
	for (const a of items) {
		const key = `${a.sessionId}\u0000${a.toolName}`;
		if (a.kind !== 'approval' || (count.get(key) ?? 0) < 2) {
			out.push({ kind: 'single', item: a });
			continue;
		}
		let g = groups.get(key);
		if (!g) {
			g = { kind: 'group', toolName: a.toolName, items: [] };
			groups.set(key, g);
			out.push(g);
		}
		g.items.push(a);
	}
	return out;
}

/** Stable key of an entry (the card is re-created when its members change). */
export function entryKey(e: PendingEntry): string {
	return e.kind === 'single' ? `${e.item.sessionId}:${e.item.id}` : `group:${e.items[0]!.sessionId}:${e.toolName}:${e.items.map((i) => i.id).join(',')}`;
}
