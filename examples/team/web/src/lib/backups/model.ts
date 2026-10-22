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

// --- workspace import ---------------------------------------------------------------------------

export type ImportPreview = components['schemas']['ImportPreview'];
export type ImportItem = components['schemas']['ImportItem'];
export type ImportResult = components['schemas']['ImportResult'];
export type RestorePoint = components['schemas']['RestorePoint'];
export type SectionId = ImportItem['section'];
export type ImportSource = components['schemas']['ImportSource'];

/** What the owner ticked: sections to apply, single items left out, sections where what is not in the zip is removed. */
export interface Ticks {
	sections: Set<SectionId>;
	exclude: Set<string>;
	remove: Set<SectionId>;
}

export const statusText: Record<ImportItem['status'], string> = {
	added: 'New here',
	changed: 'Differs',
	unchanged: 'Same',
	'only-live': 'Only in the workspace'
};

/** Every section that can be imported, ticked; nothing excluded, nothing removed (the default). */
export function defaultTicks(preview: Pick<ImportPreview, 'sections'>): Ticks {
	return { sections: new Set(preview.sections.filter((s) => s.applicable).map((s) => s.id)), exclude: new Set(), remove: new Set() };
}

/** The same rule as the server: ticked section, not left out, applicable, a change (only-here items need the removal tick). */
export function isSelected(item: ImportItem, t: Ticks): boolean {
	if (!item.applicable || item.status === 'unchanged') return false;
	if (!t.sections.has(item.section) || t.exclude.has(item.key)) return false;
	return item.status === 'only-live' ? t.remove.has(item.section) : true;
}

export function selectionBody(t: Ticks): { sections: SectionId[]; exclude: string[]; removeSections: SectionId[] } {
	return { sections: [...t.sections], exclude: [...t.exclude], removeSections: [...t.remove] };
}

/** "3 added, 2 changed, 1 removed will be applied." */
export function applySummary(items: readonly ImportItem[], t: Ticks): string {
	const picked = items.filter((i) => isSelected(i, t));
	if (!picked.length) return 'Nothing is selected to change.';
	const n = (s: ImportItem['status']): number => picked.filter((i) => i.status === s).length;
	const parts = [`${n('added')} added`, `${n('changed')} changed`];
	if (n('only-live')) parts.push(`${n('only-live')} removed`);
	return `${parts.join(', ')} will be applied.`;
}

/** What an import did, in a sentence. */
export function importResultText(r: Pick<ImportResult, 'counts'>): string {
	const c = r.counts;
	const parts = [`${c.added} added`, `${c.changed} changed`];
	if (c.removed) parts.push(`${c.removed} removed`);
	if (c.failed) parts.push(`${c.failed} failed`);
	return `${parts.join(', ')}.`;
}

export const restoreKindText: Record<RestorePoint['kind'], string> = {
	import: 'Import',
	'files-restore': 'Files restore',
	undo: 'Undo'
};

/** The line of a restore point: what, from where. */
export function restorePointText(p: Pick<RestorePoint, 'kind' | 'source' | 'counts'>): string {
	const from = p.source.kind === 'backup' ? p.source.label : 'an uploaded zip';
	return `${restoreKindText[p.kind]} from ${from}: ${importResultText({ counts: p.counts })}`;
}

/** Items of one section, changes first. */
export function itemsOf(preview: Pick<ImportPreview, 'items'>, section: SectionId): ImportItem[] {
	return preview.items.filter((i) => i.section === section);
}

/** The items that would grant something (permission mode, tools, connectors, roles) and are selected. */
export function grants(items: readonly ImportItem[], t: Ticks): ImportItem[] {
	return items.filter((i) => i.authority.length > 0 && isSelected(i, t));
}
