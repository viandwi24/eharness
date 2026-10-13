// What a viewer needs, whatever the source: a stored artifact, a fence of a message, or a library file.
import { artifactsApi, cachedViewUrl, type Artifact } from './api.js';
import { fenceArtifact, type Fence, type FenceKind } from './fences.js';
import { basename, extOf } from '#lib/files/helpers.js';
import type { ArtifactKindId } from './kinds.js';

export type ViewerInput = {
	/** Kind id (`html`, `document`, `image`, `mermaid`, `code`, `data`, `file`) that picks the viewer. */
	kind: string;
	title: string;
	/** Entry file name (extension decides svg, csv, json, the code language). */
	name: string;
	mediaType?: string;
	size?: number;
	/** Source text when it is already here (a fence). */
	text?: string;
	/** Signed URL of the entry; refreshed when it is about to expire. */
	url?: () => Promise<string>;
	/** Signed URL of a file next to the entry (a relative image of a document). */
	resolve?: (relative: string) => Promise<string>;
};

/** The source text of an input: its inline text, else fetched from the signed URL (credentials never sent). */
export async function loadText(i: ViewerInput, signal?: AbortSignal): Promise<string> {
	if (i.text !== undefined) return i.text;
	if (!i.url) throw new Error('Nothing to show');
	const res = await fetch(await i.url(), { credentials: 'omit', signal });
	if (!res.ok) throw new Error(`Could not load the content (${res.status})`);
	return res.text();
}

export function fromArtifact(a: Artifact, version?: number): ViewerInput {
	const entry = a.files.find((f) => f.path === a.entry);
	const sign = (path?: string) => cachedViewUrl(() => artifactsApi.viewUrl(a.id, { ...(version ? { version } : {}), ...(path ? { path } : {}) }));
	const resolvers = new Map<string, () => Promise<string>>();
	return {
		kind: a.kind,
		title: a.title,
		name: a.entry,
		mediaType: entry?.mediaType,
		size: entry?.size,
		url: sign(),
		resolve: (rel) => {
			const path = rel.replace(/^\.\//, '');
			let get = resolvers.get(path);
			if (!get) resolvers.set(path, (get = sign(path)));
			return get();
		}
	};
}

const FENCE_TITLE: Record<FenceKind, string> = { mermaid: 'Diagram', svg: 'Image', html: 'HTML preview' };

export function fenceTitle(kind: FenceKind, code: string): string {
	const t = kind === 'html' ? /<title[^>]*>([^<]+)<\/title>/i.exec(code)?.[1] : kind === 'svg' ? /<title[^>]*>([^<]+)<\/title>/i.exec(code)?.[1] : /^\s*title:\s*(.+)$/im.exec(code)?.[1];
	return (t?.trim() || FENCE_TITLE[kind]).slice(0, 120);
}

export function fromFence(f: Pick<Fence, 'code'> & { kind: FenceKind }): ViewerInput {
	const a = fenceArtifact(f.kind);
	return { kind: a.kind, title: fenceTitle(f.kind, f.code), name: a.file, mediaType: a.mime, text: f.code.replace(/\n+$/, '') };
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'sh', 'bash', 'css', 'sql', 'yaml', 'yml', 'toml', 'xml', 'go', 'rs', 'java', 'rb', 'diff', 'svelte']);

/** The artifact kind a library file would become, by its extension. */
export function kindOfPath(path: string): ArtifactKindId {
	const ext = extOf(path);
	if (IMAGE.has(ext)) return 'image';
	if (ext === 'html' || ext === 'htm') return 'html';
	if (ext === 'md' || ext === 'markdown') return 'document';
	if (ext === 'mmd') return 'mermaid';
	if (ext === 'csv' || ext === 'json' || ext === 'tsv') return 'data';
	if (CODE.has(ext)) return 'code';
	return 'file';
}

const BINARY = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'xlsx', 'docx', 'pptx']);
export const isBinaryPath = (path: string): boolean => BINARY.has(extOf(path));

export function fromFile(path: string): ViewerInput {
	return {
		kind: kindOfPath(path),
		title: basename(path),
		name: basename(path),
		url: cachedViewUrl(() => artifactsApi.libraryViewUrl(path))
	};
}
