import type { components } from '../api/schema';

export type LibraryEntry = components['schemas']['LibraryEntry'];
export type FileKind = 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'other';

const CODE_LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', json: 'json', py: 'python',
	sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', html: 'html', svelte: 'svelte', sql: 'sql', yaml: 'yaml',
	yml: 'yaml', toml: 'toml', xml: 'xml', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', csv: 'csv', diff: 'diff'
};

export const extOf = (path: string): string => {
	const base = basename(path);
	const i = base.lastIndexOf('.');
	return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const parentOf = (path: string): string => {
	const i = path.lastIndexOf('/');
	return i <= 0 ? '/' : path.slice(0, i);
};

/** Shiki language for a path, or null for plain text. */
export const codeLanguage = (path: string): string | null => CODE_LANG[extOf(path)] ?? null;

export function fileKind(f: Pick<LibraryEntry, 'path' | 'mediaType' | 'binary'>): FileKind {
	const mt = f.mediaType ?? '';
	const ext = extOf(f.path);
	// SVG is text (editable); the server only serves raster images inline.
	if ((mt.startsWith('image/') && mt !== 'image/svg+xml') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
	if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (f.binary) return 'other';
	if (mt === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
	if (codeLanguage(f.path)) return 'code';
	if (mt.startsWith('text/') || mt === 'application/json' || ext === 'txt' || ext === '') return 'text';
	return 'text';
}

export function formatBytes(n: number | null | undefined): string {
	if (n === null || n === undefined) return '';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type Folder = { name: string; path: string; count: number; updatedAt: number };
export type Listing = { folders: Folder[]; files: LibraryEntry[] };

const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Direct children of `folder` from a flat, recursive file list. */
export function listFolder(all: readonly LibraryEntry[], folder: string): Listing {
	const dir = norm(folder || '/');
	const prefix = dir === '/' ? '/' : `${dir}/`;
	const folders = new Map<string, Folder>();
	const files: LibraryEntry[] = [];
	for (const f of all) {
		if (!f.path.startsWith(prefix)) continue;
		const rest = f.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash < 0) {
			files.push(f);
			continue;
		}
		const name = rest.slice(0, slash);
		const cur = folders.get(name);
		if (cur) {
			cur.count++;
			cur.updatedAt = Math.max(cur.updatedAt, f.updatedAt);
		} else folders.set(name, { name, path: `${prefix}${name}`, count: 1, updatedAt: f.updatedAt });
	}
	return {
		folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
		files: files.sort((a, b) => a.path.localeCompare(b.path))
	};
}

export function breadcrumbs(path: string): { name: string; path: string }[] {
	const parts = path.split('/').filter(Boolean);
	const out = [{ name: 'Root', path: '/' }];
	let acc = '';
	for (const p of parts) out.push({ name: p, path: (acc += `/${p}`) });
	return out;
}

/** Normalise a user-typed path: leading slash, no `..`, no double slashes. Null when invalid. */
export function cleanPath(input: string): string | null {
	const parts = input.trim().split('/').filter((p) => p !== '' && p !== '.');
	if (!parts.length || parts.some((p) => p === '..')) return null;
	return `/${parts.join('/')}`;
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'log', 'ts', 'js', 'py', 'sql', 'sh']);
/** The text write route takes up to 1 MB. */
export const MAX_TEXT_WRITE_BYTES = 1_000_000;

export type UploadTarget = { mode: 'folder'; path: string } | { mode: 'uploads' };

/**
 * Where an upload from the Files page goes: into the open library folder when it is a text file the
 * text write route accepts (up to 1 MB), else the generic uploads area (binary files, other places).
 */
export function uploadTarget(dir: string, file: { name: string; type: string; size: number }): UploadTarget {
	const folder = dir.replace(/\/+$/, '');
	if (!folder.startsWith('/library/') && folder !== '/library') return { mode: 'uploads' };
	const text = file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.has(extOf(file.name));
	if (!text || file.size > MAX_TEXT_WRITE_BYTES || file.size === 0) return { mode: 'uploads' };
	const name = file.name.replace(/[\\/\0]/g, '_').trim();
	return name ? { mode: 'folder', path: `${folder}/${name}` } : { mode: 'uploads' };
}
