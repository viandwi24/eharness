// Pure helpers of Settings > Storage: human sizes, percentages and the texts of an action result.
// Unit-tested.
import type { components } from '#lib/api/schema.js';

export type Storage = components['schemas']['Storage'];
export type StorageActionResult = components['schemas']['StorageActionResult'];
export type StorageAction = StorageActionResult['action'];

/** `1.4 MB`, `820 KB`, `0 B`; `—` for unknown. */
export function sizeText(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Whole percent of `part` in `total` (0 when total is 0). */
export function percent(part: number, total: number): number {
	return total > 0 ? Math.min(100, Math.round((100 * part) / total)) : 0;
}

/** The volume is low: under 10% or under 2 GB free (the server's rule). */
export function isLowDisk(v: { totalBytes: number; freeBytes: number }): boolean {
	return v.totalBytes > 0 && (v.freeBytes < v.totalBytes * 0.1 || v.freeBytes < 2 * 1024 ** 3);
}

/** "Down 120 MB (1.2 GB → 1.1 GB)" for an action result; the database files before and after. */
export function resultText(r: Pick<StorageActionResult, 'before' | 'after' | 'message'>): string {
	const diff = r.before.dbBytes - r.after.dbBytes;
	const moved = diff > 0 ? `freed ${sizeText(diff)}` : diff < 0 ? `grew by ${sizeText(-diff)}` : 'size unchanged';
	return `${r.message}: ${moved} (${sizeText(r.before.dbBytes)} → ${sizeText(r.after.dbBytes)})`;
}

export const actionLabels: Record<StorageAction, string> = {
	compact: 'Compact database',
	checkpoint: 'Checkpoint WAL',
	retention: 'Apply retention now',
	'clear-media': 'Clear tool media'
};

/** The confirmation text of an action (what it does and what it costs). */
export function confirmText(action: StorageAction, s: Pick<Storage, 'database' | 'volume'>, days = 3): string {
	switch (action) {
		case 'compact':
			return `VACUUM rewrites the whole database (${sizeText(s.database.dbBytes)}). It needs about that much free disk (${s.volume ? sizeText(s.volume.freeBytes) : 'unknown'} free) and blocks writes for a few seconds per GB. It is refused when there is not enough space.`;
		case 'checkpoint':
			return 'Writes the pending changes of the write-ahead log into the database file and empties the log. Safe; it can wait a moment if a request is writing.';
		case 'retention':
			return 'Deletes what the retention settings no longer keep: old finished runs, tasks, library history, tool media, model call log rows and events.';
		case 'clear-media':
			return `Deletes tool media and browser screenshots older than ${days} days. A chat that still shows one then shows "expired".`;
	}
}
