// Pure helpers of Settings > Backups: size and reason texts, and the plain-language summaries of a
// restore preview and result. Unit-tested.
import type { components } from '#lib/api/schema.js';

export type Backup = components['schemas']['Backup'];
export type RestorePlan = components['schemas']['RestorePlan'];
export type RestoreResult = components['schemas']['RestoreResult'];

/** `1.4 MB`, `820 KB`, `0 B`. */
export function bytesText(n: number | null | undefined): string {
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

/** What a snapshot was taken for, in words. */
export function reasonLabel(b: Pick<Backup, 'reason' | 'kind'>): string {
	switch (b.kind) {
		case 'daily':
			return 'Daily';
		case 'startup':
			return 'At start-up';
		case 'manual':
			return 'Manual';
		default:
			return b.reason.replace(/^before:\s*/, 'Before: ');
	}
}

/** The one line of a snapshot's health: verified, or why not. */
export function verifiedText(b: Pick<Backup, 'verified' | 'error' | 'exportError'>): string {
	if (!b.verified) return `Not verified: ${b.error ?? 'unknown problem'}`;
	if (b.exportError) return `Verified, but the files export is missing: ${b.exportError}`;
	return 'Verified';
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 files would be created, 1 replaced; 3 already the same." */
export function planSummary(p: Pick<RestorePlan, 'counts' | 'mode'>): string {
	const c = p.counts;
	const parts: string[] = [];
	if (c.create) parts.push(`${plural(c.create, 'file', 'files')} would be created`);
	if (c.replace) parts.push(`${c.replace} would be replaced by the older text`);
	if (c.keep) parts.push(`${c.keep} changed since the snapshot ${c.keep === 1 ? 'is' : 'are'} left alone`);
	const same = c.same ? `${c.same} already the same` : '';
	if (!parts.length) return c.same ? `Nothing to restore: ${c.same} already the same.` : 'No files at that path in this snapshot.';
	return `${parts.join(', ')}${same ? `; ${same}` : ''}.`;
}

/** What a finished restore did. */
export function resultSummary(r: RestoreResult): string {
	const parts = [`${plural(r.created, 'file', 'files')} created`, `${r.replaced} replaced`];
	if (r.kept) parts.push(`${r.kept} left alone`);
	if (r.failed.length) parts.push(`${r.failed.length} failed`);
	return `${parts.join(', ')}.`;
}
