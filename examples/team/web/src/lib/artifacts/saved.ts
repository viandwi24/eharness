// The `Saved: /library/a.png, /library/b.csv` footer of a `run_python` result (plan P45 R6).

const LINE = /^\s*saved(?:\s+files?)?\s*:\s*(.+?)\s*$/gim;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Library paths the run saved, in order, without duplicates. */
export function parseSaved(output: unknown): string[] {
	const text = typeof output === 'string' ? output : output && typeof output === 'object' ? textOf(output) : '';
	const out: string[] = [];
	for (const m of text.matchAll(LINE)) {
		for (const raw of (m[1] as string).split(',')) {
			const p = raw.trim().replace(/^["'`]|["'`.]$/g, '');
			if (p.startsWith('/') && !out.includes(p)) out.push(p);
		}
	}
	return out;
}

function textOf(o: object): string {
	const r = o as { stdout?: unknown; output?: unknown; text?: unknown };
	for (const v of [r.output, r.stdout, r.text]) if (typeof v === 'string') return v;
	return '';
}

export const isImagePath = (p: string): boolean => IMAGE.test(p);
