import { describe, expect, test } from 'bun:test';
import { ApiError } from './api/client';
import { conflictVersion, diffStats, isFileExists, lineDiff, saveWithConflict } from './conflict';

const conflict = new ApiError(409, 'VERSION_CONFLICT', 'stale', { currentVersion: 'abc' });

describe('conflict helpers', () => {
	test('conflictVersion reads the 409 envelope', () => {
		expect(conflictVersion(conflict)).toEqual({ currentVersion: 'abc' });
		expect(conflictVersion(new ApiError(409, 'VERSION_CONFLICT', 'x'))).toEqual({ currentVersion: null });
		expect(conflictVersion(new ApiError(409, 'FILE_EXISTS', 'x'))).toBeNull();
		expect(conflictVersion(new Error('x'))).toBeNull();
		expect(isFileExists(new ApiError(409, 'FILE_EXISTS', 'x'))).toBe(true);
	});

	test('saveWithConflict folds only the stale-edit error', async () => {
		expect(await saveWithConflict(async () => ({ version: 'v2' }))).toEqual({ ok: true, version: 'v2' });
		expect(
			await saveWithConflict(async () => {
				throw conflict;
			})
		).toEqual({ ok: false, conflict: { currentVersion: 'abc' } });
		await expect(
			saveWithConflict(async () => {
				throw new ApiError(500, 'INTERNAL', 'boom');
			})
		).rejects.toThrow('boom');
	});

	test('lineDiff marks mine-only as del and theirs-only as add', () => {
		const d = lineDiff('a\nb\nc', 'a\nx\nc\nd');
		expect(d).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'del', text: 'b' },
			{ kind: 'add', text: 'x' },
			{ kind: 'same', text: 'c' },
			{ kind: 'add', text: 'd' }
		]);
		expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
		expect(lineDiff('same', 'same').every((l) => l.kind === 'same')).toBe(true);
	});
});
