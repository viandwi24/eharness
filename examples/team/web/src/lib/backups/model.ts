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

/**
 * What the owner ticked: sections to apply, single items left out, sections where what is not in the
 * zip is removed, and whether an item that exists here and differs is replaced (`overwrite`) or skipped.
 */
export interface Ticks {
	sections: Set<SectionId>;
	exclude: Set<string>;
	remove: Set<SectionId>;
	overwrite: boolean;
	/** Also replace or remove what was changed here after the zip was exported (the `conflict` items). */
	overwriteConflicts: boolean;
	/** Rewrite references (programs, standing orders, notes, API grants) to the moved paths. */
	rewrite: boolean;
}

export const MIN_PASSPHRASE = 12;

/** Why a passphrase is not good enough, or null. */
export function passphraseProblem(pass: string, again?: string): string | null {
	if (pass.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
	if (again !== undefined && again !== pass) return 'The two passphrases differ.';
	return null;
}

export const statusText: Record<ImportItem['status'], string> = {
	added: 'New here',
	changed: 'Differs',
	unchanged: 'Same',
	'only-live': 'Only in the workspace'
};

/** Sections never ticked by default: conversations (large) and secrets (need the passphrase). */
const OPT_IN: ReadonlySet<SectionId> = new Set<SectionId>(['conversations', 'secrets']);

/**
 * Every section that can be imported, ticked; nothing excluded, nothing removed, no overwrite (the
 * default). Secrets are ticked only once the passphrase has opened them (`unlocked`).
 */
export function defaultTicks(preview: Pick<ImportPreview, 'sections'> & Partial<Pick<ImportPreview, 'secrets'>> & { references?: Pick<ImportPreview['references'], 'rewritable'> }): Ticks {
	const unlocked = preview.secrets?.unlocked === true;
	return {
		sections: new Set(preview.sections.filter((s) => s.applicable && (!OPT_IN.has(s.id) || (s.id === 'secrets' && unlocked))).map((s) => s.id)),
		exclude: new Set(),
		remove: new Set(),
		overwrite: false,
		// the one-click rewrite is offered ticked when the moves leave references it can fix; conflicts are never ticked
		overwriteConflicts: false,
		rewrite: (preview.references?.rewritable ?? 0) > 0
	};
}

/**
 * The same rule as the server: ticked section, not left out, applicable, a change; an item that
 * differs needs `overwrite`; an item changed here after the export (`conflict`) also needs
 * `overwriteConflicts`, to be replaced or removed; only-here items need the removal tick; a reference
 * rewrite needs the rewrite tick (and follows the moves, not a section).
 */
export function isSelected(item: ImportItem, t: Ticks): boolean {
	if (!item.applicable || item.status === 'unchanged') return false;
	if (t.exclude.has(item.key)) return false;
	if (item.kind === 'reference') return t.rewrite;
	if (!t.sections.has(item.section)) return false;
	if (item.conflict && !t.overwriteConflicts) return false;
	if (item.status === 'only-live') return t.remove.has(item.section);
	return item.status !== 'changed' || t.overwrite;
}

export function selectionBody(t: Ticks): { sections: SectionId[]; exclude: string[]; removeSections: SectionId[]; overwrite: boolean; overwriteConflicts: boolean; rewriteReferences: boolean } {
	return { sections: [...t.sections], exclude: [...t.exclude], removeSections: [...t.remove], overwrite: t.overwrite, overwriteConflicts: t.overwriteConflicts, rewriteReferences: t.rewrite };
}

/** The same ticks with the conflict choice set (to count what the tick would add). */
export const withConflicts = (t: Ticks, overwriteConflicts: boolean): Ticks => ({ ...t, overwriteConflicts });

/** Items changed here after the export that are ticked but kept as they are (the conflict tick is off). */
export function keptConflictCount(items: readonly ImportItem[], t: Ticks): number {
	return items.filter((i) => i.conflict && isSelected(i, withConflicts(t, true)) && !isSelected(i, withConflicts(t, false))).length;
}

/** The same ticks with the overwrite choice set (to count what each button would do). */
export const withOverwrite = (t: Ticks, overwrite: boolean): Ticks => ({ ...t, overwrite });

/** Differing items that "skip existing" leaves as they are (ticked, applicable, but not replaced). */
export function skippedCount(items: readonly ImportItem[], t: Ticks): number {
	return items.filter((i) => i.status === 'changed' && isSelected(i, withOverwrite(t, true)) && !isSelected(i, withOverwrite(t, false))).length;
}

/** "3 added, 2 changed, 1 removed will be applied; 4 that differ are kept as they are." */
export function applySummary(items: readonly ImportItem[], t: Ticks): string {
	const picked = items.filter((i) => isSelected(i, t));
	const kept = t.overwrite ? 0 : skippedCount(items, t);
	const keptText = kept ? ` ${kept} that ${kept === 1 ? 'differs is' : 'differ are'} kept as ${kept === 1 ? 'it is' : 'they are'}.` : '';
	const conflicts = keptConflictCount(items, t);
	const conflictText = conflicts ? ` ${conflicts} changed here since the export ${conflicts === 1 ? 'keeps' : 'keep'} the live version.` : '';
	if (!picked.length) return `Nothing is selected to change.${keptText}${conflictText}`;
	const plain = picked.filter((i) => i.kind !== 'move' && i.kind !== 'reference');
	const n = (s: ImportItem['status']): number => plain.filter((i) => i.status === s).length;
	const parts = [`${n('added')} added`, `${n('changed')} replaced`];
	const moved = picked.filter((i) => i.kind === 'move').length;
	const rewritten = picked.filter((i) => i.kind === 'reference').length;
	if (moved) parts.push(`${moved} moved`);
	if (rewritten) parts.push(`${rewritten} reference${rewritten === 1 ? '' : 's'} rewritten`);
	if (n('only-live')) parts.push(`${n('only-live')} removed`);
	return `${parts.join(', ')} will be applied.${keptText}${conflictText}`;
}

/** What an import did, in a sentence. */
export function importResultText(r: Pick<ImportResult, 'counts'>): string {
	const c = r.counts;
	const parts = [`${c.added} added`, `${c.changed} changed`];
	if (c.removed) parts.push(`${c.removed} removed`);
	if (c.failed) parts.push(`${c.failed} failed`);
	return `${parts.join(', ')}.`;
}

export type Migration = components['schemas']['MigrationList']['migrations'][number];

/** "3 files and 1 folder moved": the line of one migration of the Moves list. */
export function migrationText(m: Pick<Migration, 'files' | 'folders'>): string {
	const parts = [];
	if (m.folders) parts.push(`${m.folders} folder${m.folders === 1 ? '' : 's'}`);
	if (m.files) parts.push(`${m.files} file${m.files === 1 ? '' : 's'}`);
	return `${parts.join(' and ') || 'Nothing'} moved`;
}

export const restoreKindText: Record<RestorePoint['kind'], string> = {
	import: 'Import',
	'files-restore': 'Files restore',
	undo: 'Undo',
	'memory-reorganization': 'Memory reorganization',
	'database-restore': 'Whole database restore'
};

/** The line of a restore point: what, from where. */
export function restorePointText(p: Pick<RestorePoint, 'kind' | 'source' | 'counts'>): string {
	if (p.kind === 'database-restore') return `${restoreKindText[p.kind]} from ${p.source.kind === 'backup' ? p.source.label : 'a backup'}`;
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

// --- whole-database restore ---------------------------------------------------------------------

export type DatabaseRestorePreview = components['schemas']['DatabaseRestorePreview'];
export type DatabaseRestoreTable = components['schemas']['DatabaseRestoreTable'];
export type DatabaseRestoreStatus = components['schemas']['DatabaseRestoreStatus'];

export const tableClassText: Record<DatabaseRestoreTable['class'], string> = {
	zip: 'Also in the zip',
	snapshot: 'Database copy only',
	derived: 'Cache',
	unknown: 'Unknown'
};

/** `+3`, `-12`, `0` (a real minus sign is avoided so the text stays plain ASCII). */
export function deltaText(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

/** Tables whose row count differs first (biggest change first), then the unchanged ones. */
export function splitTables(tables: readonly DatabaseRestoreTable[]): { changed: DatabaseRestoreTable[]; unchanged: DatabaseRestoreTable[] } {
	const changed = tables.filter((t) => t.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.table.localeCompare(b.table));
	const unchanged = tables.filter((t) => t.delta === 0).sort((a, b) => a.table.localeCompare(b.table));
	return { changed, unchanged };
}

/** The confirmation is exact apart from surrounding blanks and letter case. */
export function phraseMatches(typed: string, phrase: string): boolean {
	return typed.trim().toLowerCase() === phrase.trim().toLowerCase();
}

/** What the restart will look like, in words. */
export function restartText(restart: DatabaseRestorePreview['restart']): string {
	return restart === 'automatic'
		? 'The server restarts by itself: it exits and its process manager starts it again. Everyone is disconnected for a moment.'
		: 'The server cannot restart itself here: after you confirm, the restore is staged and applies when you restart the server yourself.';
}

/** The totals line of the preview. */
export function totalsText(totals: DatabaseRestorePreview['totals']): string {
	return `${totals.backup} rows in the backup, ${totals.live} in the running database (${deltaText(totals.backup - totals.live)}).`;
}

/** What the last start did with a staged restore, or null when there is nothing to say. */
export function lastRestoreText(last: DatabaseRestoreStatus['last']): { ok: boolean; text: string } | null {
	if (!last) return null;
	return last.ok ? { ok: true, text: `The whole-database restore of backup ${last.backupId} was applied.` } : { ok: false, text: `The whole-database restore of backup ${last.backupId} failed: ${last.error ?? 'unknown problem'}. The database was left as it was.` };
}
