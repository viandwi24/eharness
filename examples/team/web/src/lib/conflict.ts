import { ApiError } from './api/client';

/** The server's 409 for a stale edit: `error.details.currentVersion` is what the file has now. */
export function conflictVersion(err: unknown): { currentVersion: string | null } | null {
	if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'VERSION_CONFLICT') return null;
	const v = (err.details as { currentVersion?: unknown } | undefined)?.currentVersion;
	return { currentVersion: typeof v === 'string' ? v : null };
}

export const isFileExists = (err: unknown): boolean => err instanceof ApiError && err.status === 409 && err.code === 'FILE_EXISTS';

export type SaveOutcome =
	| { ok: true; version: string }
	| { ok: false; conflict: { currentVersion: string | null } };

/**
 * Run a save and fold a stale-edit 409 into a value, so the UI can offer reload / overwrite.
 * Any other failure still throws.
 */
export async function saveWithConflict(save: () => Promise<{ version: string }>): Promise<SaveOutcome> {
	try {
		return { ok: true, version: (await save()).version };
	} catch (e) {
		const c = conflictVersion(e);
		if (c) return { ok: false, conflict: c };
		throw e;
	}
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 4_000_000;

/** Line diff (LCS). `mine` -> `theirs`: `del` lines exist only in mine, `add` lines only in theirs. */
export function lineDiff(mine: string, theirs: string): DiffLine[] {
	const a = mine.split('\n');
	const b = theirs.split('\n');
	if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
		return [...a.map((text): DiffLine => ({ kind: 'del', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
	}
	const w = b.length + 1;
	const t = new Uint32Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) out.push({ kind: 'same', text: a[i++]! }), j++;
		else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push({ kind: 'del', text: a[i++]! });
		else out.push({ kind: 'add', text: b[j++]! });
	}
	while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
	while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
	return out;
}

export const diffStats = (d: readonly DiffLine[]): { added: number; removed: number } => ({
	added: d.filter((x) => x.kind === 'add').length,
	removed: d.filter((x) => x.kind === 'del').length
});
