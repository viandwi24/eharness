import { describe, expect, test } from 'bun:test';
import { bytesText, planSummary, reasonLabel, resultSummary, verifiedText } from './model';

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
		expect(resultSummary({ created: 1, replaced: 0, unchanged: 3, kept: 2, failed: [{ path: '/x', error: 'e' }], safetyBackupId: null })).toBe('1 file created, 0 replaced, 2 left alone, 1 failed.');
	});
});
