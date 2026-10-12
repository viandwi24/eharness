// "Sending will decline N pending approvals (web_search ×3)": what a new message does to the own
// approvals of a chat (library default `onNewInput: 'deny'`, spec 11 §4.1). Approvals of delegated
// children belong to another session and are not affected. Pure, unit-tested.
import type { Approval } from '../api/client.js';

export type DeclineHint = { count: number; names: { toolName: string; count: number }[]; text: string };

/** `undefined` when nothing of this chat's own would be declined. */
export function declineHint(own: readonly Approval[], delegated = 0): DeclineHint | undefined {
	const items = own.filter((a) => a.kind === 'approval');
	if (items.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const a of items) counts.set(a.toolName, (counts.get(a.toolName) ?? 0) + 1);
	const names = [...counts].map(([toolName, count]) => ({ toolName, count }));
	const list = names.map((n) => (n.count > 1 ? `${n.toolName} ×${n.count}` : n.toolName)).join(', ');
	const noun = items.length === 1 ? 'approval' : 'approvals';
	const stay = delegated > 0 ? `; ${delegated} from delegated agents stay open` : '';
	return { count: items.length, names, text: `Sending will decline ${items.length} pending ${noun} (${list})${stay}` };
}
