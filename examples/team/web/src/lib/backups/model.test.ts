import { describe, expect, test } from 'bun:test';
import { applySummary, bytesText, defaultTicks, grants, importResultText, type ImportItem, isSelected, planSummary, reasonLabel, resultSummary, selectionBody, verifiedText } from './model';

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
	...over
});

describe('import ticks', () => {
	const sections = (['library', 'agents', 'connections'] as const).map((id) => ({ id, label: id, added: 0, changed: 0, unchanged: 0, onlyLive: 0, applicable: id !== 'connections' }));
	test('every importable section is ticked by default, reference sections never', () => {
		const t = defaultTicks({ sections });
		expect([...t.sections].sort()).toEqual(['agents', 'library']);
		expect(t.remove.size).toBe(0);
	});
	test('selection follows the server rule: sections, single items, removal tick, reference items', () => {
		const t = defaultTicks({ sections });
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
		expect(selectionBody(t)).toEqual({ sections: ['agents'], exclude: [], removeSections: ['library'] });
	});
	test('summaries and grants', () => {
		const t = defaultTicks({ sections });
		const items = [item({ status: 'added' }), item({ key: 'b', status: 'changed', authority: ['permission mode: auto'] }), item({ key: 'c', status: 'only-live' })];
		expect(applySummary(items, t)).toBe('1 added, 1 changed will be applied.');
		expect(applySummary([item({ status: 'only-live' })], t)).toBe('Nothing is selected to change.');
		expect(grants(items, t).map((i) => i.key)).toEqual(['b']);
		expect(importResultText({ counts: { added: 1, changed: 2, removed: 0, failed: 1 } })).toBe('1 added, 2 changed, 1 failed.');
	});
});
