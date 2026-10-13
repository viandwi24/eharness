// Table data for the data viewer: CSV (RFC 4180) and JSON arrays, sorted and filtered in the browser.
export type Table = { columns: string[]; rows: string[][] };

export function parseCsv(text: string): string[][] {
	const sep = (text.split('\n', 1)[0] ?? '').split(';').length > (text.split('\n', 1)[0] ?? '').split(',').length ? ';' : ',';
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else cell += c;
		} else if (c === '"') quoted = true;
		else if (c === sep) {
			row.push(cell);
			cell = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += c;
	}
	if (cell !== '' || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A table from CSV text or a JSON array (of objects or of arrays); `undefined` when it has no table shape. */
export function toTable(text: string, name: string): Table | undefined {
	if (/\.json$/i.test(name)) {
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (!Array.isArray(data) || data.length === 0) return undefined;
		if (data.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
			const columns = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
			return { columns, rows: data.map((r) => columns.map((c) => show((r as Record<string, unknown>)[c]))) };
		}
		if (data.every(Array.isArray)) {
			const w = Math.max(...data.map((r) => (r as unknown[]).length));
			return { columns: Array.from({ length: w }, (_, i) => `Column ${i + 1}`), rows: data.map((r) => Array.from({ length: w }, (_, i) => show((r as unknown[])[i]))) };
		}
		return undefined;
	}
	const all = parseCsv(text);
	const [head, ...rows] = all;
	if (!head) return undefined;
	return { columns: head.map((h, i) => h || `Column ${i + 1}`), rows };
}

export type Sort = { col: number; dir: 'asc' | 'desc' } | null;

const num = (s: string): number | undefined => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** Rows matching `filter` (any cell contains it, case-insensitive), ordered by `sort` (numbers numerically). */
export function view(rows: readonly string[][], filter: string, sort: Sort): string[][] {
	const q = filter.trim().toLowerCase();
	let out = q ? rows.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : [...rows];
	if (sort) {
		const { col, dir } = sort;
		const k = dir === 'asc' ? 1 : -1;
		out = out.sort((a, b) => {
			const x = a[col] ?? '';
			const y = b[col] ?? '';
			const nx = num(x);
			const ny = num(y);
			return k * (nx !== undefined && ny !== undefined ? nx - ny : x.localeCompare(y, undefined, { numeric: true }));
		});
	}
	return out;
}

/** Next sort when a header is clicked: ascending, descending, off. */
export const nextSort = (cur: Sort, col: number): Sort => (cur?.col !== col ? { col, dir: 'asc' } : cur.dir === 'asc' ? { col, dir: 'desc' } : null);
