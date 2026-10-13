// What the chat's side panel shows, carried in the URL so a reload keeps it open (plan P45 R1).
export type PanelTarget =
	| { kind: 'artifact'; id: string; version?: number }
	| { kind: 'preview'; messageId: string; index: number }
	| { kind: 'file'; path: string };

const KEYS = ['artifact', 'v', 'preview', 'file'] as const;

type Params = Pick<URLSearchParams, 'get' | 'toString'>;

export function parsePanel(params: Params): PanelTarget | null {
	const artifact = params.get('artifact');
	if (artifact) {
		const v = Number(params.get('v'));
		return { kind: 'artifact', id: artifact, ...(Number.isInteger(v) && v > 0 ? { version: v } : {}) };
	}
	const preview = params.get('preview');
	if (preview) {
		const at = preview.lastIndexOf(':');
		const index = Number(preview.slice(at + 1));
		if (at > 0 && Number.isInteger(index) && index >= 0) return { kind: 'preview', messageId: preview.slice(0, at), index };
	}
	const file = params.get('file');
	if (file?.startsWith('/')) return { kind: 'file', path: file };
	return null;
}

/** `search` of the same page with the panel set to `target` (or closed for `null`). */
export function panelSearch(current: Params, target: PanelTarget | null): string {
	const next = new URLSearchParams(current.toString());
	for (const k of KEYS) next.delete(k);
	if (target?.kind === 'artifact') {
		next.set('artifact', target.id);
		if (target.version) next.set('v', String(target.version));
	} else if (target?.kind === 'preview') next.set('preview', `${target.messageId}:${target.index}`);
	else if (target?.kind === 'file') next.set('file', target.path);
	const s = next.toString();
	return s ? `?${s}` : '';
}

export const sameTarget = (a: PanelTarget | null, b: PanelTarget | null): boolean => JSON.stringify(a) === JSON.stringify(b);
