import { describe, expect, test } from 'bun:test';
import { applySummary, keptConflictCount, migrationText, withConflicts, deltaText, lastRestoreText, phraseMatches, restorePointText, splitTables, bytesText, defaultTicks, grants, importResultText, type ImportItem, type SectionId, isSelected, passphraseProblem, planSummary, reasonLabel, resultSummary, selectionBody, skippedCount, verifiedText, withOverwrite } from './model';

describe('backups model', () => {
	test('sizes', () => {
		expect(bytesText(0)).toBe('0 B');
		expect(bytesText(2048)).toBe('2.0 KB');
		expect(bytesText(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(bytesText(null)).toBe('—');
	});
	test('reasons', () => {
		expect(reasonLabel({ kind: 'daily', reason: 'daily' })).toBe('Daily');
		expect(reasonLabel({ kind: 'before', reason: 'before: move memory' })).toBe('Before: move memory');
	});
	test('a failed snapshot says why, never "verified"', () => {
		expect(verifiedText({ verified: false, error: 'integrity check failed', exportError: null })).toContain('integrity check failed');
		expect(verifiedText({ verified: true, error: null, exportError: null })).toBe('Verified');
		expect(verifiedText({ verified: true, error: null, exportError: 'too big' })).toContain('files export is missing');
	});
	test('preview and result sentences', () => {
		expect(planSummary({ mode: 'missing', counts: { create: 2, replace: 0, keep: 1, same: 5 } })).toBe('2 files would be created, 1 changed since the snapshot is left alone; 5 already the same.');
		expect(planSummary({ mode: 'all', counts: { create: 0, replace: 0, keep: 0, same: 0 } })).toBe('No files at that path in this snapshot.');
		expect(resultSummary({ created: 1, replaced: 0, unchanged: 3, kept: 2, failed: [{ path: '/x', error: 'e' }], safetyBackupId: null, restorePointId: null })).toBe('1 file created, 0 replaced, 2 left alone, 1 failed.');
	});
});

const item = (over: Partial<ImportItem>): ImportItem => ({
	key: 'library/a.md',
	section: 'library',
	kind: 'file',
	label: '/library/a.md',
	status: 'changed',
	applicable: true,
	blocked: null,
	fields: [],
	diff: null,
	authority: [],
	notes: [],
	sizeBefore: null,
	sizeAfter: null,
	conflict: false,
	move: null,
	...over
});

describe('import ticks', () => {
	const sections = (['library', 'agents', 'connections'] as const).map((id) => ({ id, label: id, added: 0, changed: 0, unchanged: 0, onlyLive: 0, moved: 0, conflicts: 0, applicable: id !== 'connections' }));
	test('every importable section is ticked by default, reference sections never', () => {
		const t = defaultTicks({ sections });
		expect([...t.sections].sort()).toEqual(['agents', 'library']);
		expect(t.remove.size).toBe(0);
	});
	test('selection follows the server rule: sections, single items, removal tick, reference items', () => {
		const t = defaultTicks({ sections });
		t.overwrite = true;
		expect(isSelected(item({}), t)).toBe(true);
		expect(isSelected(item({ status: 'unchanged' }), t)).toBe(false);
		expect(isSelected(item({ applicable: false }), t)).toBe(false);
		t.exclude.add('library/a.md');
		expect(isSelected(item({}), t)).toBe(false);
		t.exclude.clear();
		const only = item({ status: 'only-live' });
		expect(isSelected(only, t)).toBe(false);
		t.remove.add('library');
		expect(isSelected(only, t)).toBe(true);
		t.sections.delete('library');
		expect(isSelected(only, t)).toBe(false);
		expect(selectionBody(t)).toEqual({ sections: ['agents'], exclude: [], removeSections: ['library'], overwrite: true, overwriteConflicts: false, rewriteReferences: false });
	});
	test('an item that differs is skipped unless overwrite is chosen; new ones are always added', () => {
		const t = defaultTicks({ sections });
		expect(t.overwrite).toBe(false);
		expect(isSelected(item({ status: 'changed' }), t)).toBe(false);
		expect(isSelected(item({ status: 'added' }), t)).toBe(true);
		expect(isSelected(item({ status: 'changed' }), withOverwrite(t, true))).toBe(true);
		expect(selectionBody(withOverwrite(t, true)).overwrite).toBe(true);
	});
	test('secrets are ticked only once the passphrase opened them', () => {
		const withSecrets = [...sections, { id: 'secrets' as const, label: 'Secrets', added: 0, changed: 0, unchanged: 0, onlyLive: 0, moved: 0, conflicts: 0, applicable: true }];
		expect(defaultTicks({ sections: withSecrets, secrets: { included: true, count: 2, unlocked: false } }).sections.has('secrets')).toBe(false);
		expect(defaultTicks({ sections: withSecrets, secrets: { included: true, count: 2, unlocked: true } }).sections.has('secrets')).toBe(true);
	});
	test('passphrases: at least 12 characters, typed twice', () => {
		expect(passphraseProblem('short')).toContain('at least 12');
		expect(passphraseProblem('a long enough one', 'another one entirely')).toContain('differ');
		expect(passphraseProblem('a long enough one', 'a long enough one')).toBeNull();
	});
	test('summaries and grants', () => {
		const t = defaultTicks({ sections });
		const items = [item({ status: 'added' }), item({ key: 'b', status: 'changed', authority: ['permission mode: auto'] }), item({ key: 'c', status: 'only-live' })];
		expect(applySummary(items, t)).toBe('1 added, 0 replaced will be applied. 1 that differs is kept as it is.');
		expect(skippedCount(items, t)).toBe(1);
		expect(applySummary(items, withOverwrite(t, true))).toBe('1 added, 1 replaced will be applied.');
		expect(applySummary([item({ status: 'only-live' })], t)).toBe('Nothing is selected to change.');
		expect(grants(items, withOverwrite(t, true)).map((i) => i.key)).toEqual(['b']);
		expect(importResultText({ counts: { added: 1, changed: 2, removed: 0, failed: 1 } })).toBe('1 added, 2 changed, 1 failed.');
	});
});

describe('moves, conflicts and the reference rewrite', () => {
	const sections = [{ id: 'library' as const, label: 'library', added: 0, changed: 0, unchanged: 0, onlyLive: 0, moved: 0, conflicts: 0, applicable: true }];
	test('a conflict is kept until its own tick, even with overwrite and the removal tick', () => {
		const t = { ...defaultTicks({ sections }), overwrite: true };
		t.remove.add('library');
		const changed = item({ status: 'changed', conflict: true });
		const only = item({ key: 'b', status: 'only-live', conflict: true });
		expect(isSelected(changed, t)).toBe(false);
		expect(isSelected(only, t)).toBe(false);
		expect(keptConflictCount([changed, only], t)).toBe(2);
		expect(isSelected(changed, withConflicts(t, true))).toBe(true);
		expect(isSelected(only, withConflicts(t, true))).toBe(true);
		expect(applySummary([changed], t)).toContain('keeps the live version');
		expect(selectionBody(withConflicts(t, true)).overwriteConflicts).toBe(true);
	});
	test('a move is applied with its section; a reference rewrite only with its tick, whatever the sections', () => {
		const t = defaultTicks({ sections, references: { rewritable: 2 } });
		expect(t.rewrite).toBe(true);
		const move = item({ key: 'move:/library/a.md', kind: 'move', status: 'added', move: { from: '/library/a.md', to: '/library/b.md', kind: 'file', files: 1, source: 'detected' } });
		const ref = item({ key: 'ref:program:x', section: 'programs', kind: 'reference', status: 'changed' });
		expect(isSelected(move, t)).toBe(true);
		expect(isSelected(ref, t)).toBe(true);
		t.rewrite = false;
		expect(isSelected(ref, t)).toBe(false);
		expect(defaultTicks({ sections }).rewrite).toBe(false);
		expect(applySummary([move], { ...t, rewrite: true })).toBe('0 added, 0 replaced, 1 moved will be applied.');
		expect(migrationText({ files: 3, folders: 1 })).toBe('1 folder and 3 files moved');
	});
});

describe('whole-database restore', () => {
	const t = (table: string, delta: number) => ({ table, class: 'zip' as const, feature: 'f', backup: 1, live: 1, delta });
	test('changed tables first, biggest change first', () => {
		const r = splitTables([t('c', 0), t('b', -5), t('a', 2), t('d', 0)]);
		expect(r.changed.map((x) => x.table)).toEqual(['b', 'a']);
		expect(r.unchanged.map((x) => x.table)).toEqual(['c', 'd']);
		expect(deltaText(3)).toBe('+3');
		expect(deltaText(-3)).toBe('-3');
	});
	test('the phrase must match', () => {
		expect(phraseMatches(' Restore whole database ', 'restore whole database')).toBe(true);
		expect(phraseMatches('restore', 'restore whole database')).toBe(false);
	});
	test('last restore and restore point text', () => {
		expect(lastRestoreText(null)).toBeNull();
		expect(lastRestoreText({ ok: false, at: 1, backupId: 'b', restorePointId: 'r', error: 'boom' })?.text).toContain('boom');
		expect(restorePointText({ kind: 'database-restore', source: { kind: 'backup', backupId: 'b', label: 'x' }, counts: { added: 0, changed: 0, removed: 0, failed: 0 } })).toBe('Whole database restore from x');
	});
	test('conversations are never ticked by default', () => {
		const sections = ['library', 'conversations'].map((id) => ({ id: id as SectionId, label: id, added: 0, changed: 0, unchanged: 0, onlyLive: 0, moved: 0, conflicts: 0, applicable: true }));
		expect([...defaultTicks({ sections }).sections]).toEqual(['library']);
	});
});
