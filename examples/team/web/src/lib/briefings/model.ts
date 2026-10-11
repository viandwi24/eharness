// Briefings and the bell (P40 phase M). Pure.
import type { Briefing, BriefingItem, Notification } from '../api/client';

export const ITEM_KIND_LABEL: Record<BriefingItem['kind'], string> = {
	run: 'Ran',
	decision: 'Decision',
	waiting: 'Waiting for you',
	noticed: 'Noticed',
	cost: 'Cost'
};

/** Items grouped by kind in the order a person reads them; empty groups are left out. */
export function groupItems(items: readonly BriefingItem[]): Array<{ kind: BriefingItem['kind']; label: string; items: Array<{ index: number; item: BriefingItem }> }> {
	const order: BriefingItem['kind'][] = ['run', 'waiting', 'decision', 'noticed', 'cost'];
	return order
		.map((kind) => ({
			kind,
			label: ITEM_KIND_LABEL[kind],
			items: items.map((item, index) => ({ item, index })).filter((x) => x.item.kind === kind)
		}))
		.filter((g) => g.items.length > 0);
}

/** The briefing to open: the one asked for by id, else the newest. */
export const pickBriefing = (briefings: readonly Briefing[], id: string | null): Briefing | undefined => briefings.find((b) => b.id === id) ?? briefings[0];

/** Where a notification leads: its own link, else nothing. */
export const notificationLink = (n: Pick<Notification, 'link'>): string | null => (n.link && n.link.startsWith('/') ? n.link : null);

/** Newest first, alerts before briefings of the same minute is not needed: plain creation order. */
export const byNewest = <T extends { createdAt: number }>(list: readonly T[]): T[] => [...list].sort((a, b) => b.createdAt - a.createdAt);
