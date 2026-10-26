// Line diff of two script versions, in hunks with a few lines of context (LCS from conflict.ts).
import { type DiffLine, lineDiff } from '../conflict';

export type NumberedLine = DiffLine & { a: number | null; b: number | null };
export type Hunk = { lines: NumberedLine[] };
export type VersionDiff = { hunks: Hunk[]; added: number; removed: number };

/** Each line with its number in the old (`a`) and new (`b`) text. */
export function numberLines(d: readonly DiffLine[]): NumberedLine[] {
	let a = 0;
	let b = 0;
	return d.map((l) => {
		if (l.kind === 'same') return { ...l, a: ++a, b: ++b };
		if (l.kind === 'del') return { ...l, a: ++a, b: null };
		return { ...l, a: null, b: ++b };
	});
}

/** `older` -> `newer` as hunks: changed lines with `context` unchanged lines around them. */
export function versionDiff(older: string, newer: string, context = 3): VersionDiff {
	const lines = numberLines(lineDiff(older, newer));
	let added = 0;
	let removed = 0;
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((l, i) => {
		if (l.kind === 'same') return;
		if (l.kind === 'add') added++;
		else removed++;
		for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
	});
	const hunks: Hunk[] = [];
	let cur: Hunk | null = null;
	lines.forEach((l, i) => {
		if (!keep[i]) {
			cur = null;
			return;
		}
		if (!cur) {
			cur = { lines: [] };
			hunks.push(cur);
		}
		cur.lines.push(l);
	});
	return { hunks, added, removed };
}
