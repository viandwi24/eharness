// Fence detection in assistant text (plan P45 R3). Pure: the web scans the message text, nothing is
// stored. A preview is addressed by `<messageId>:<index>`, where the index counts every fence of the
// message in order (all text parts joined by a blank line), so a reload finds the same block again.

export type Fence = {
	/** Position among all fences of the message. */
	index: number;
	/** First word of the info string, lower-cased ("" when none). */
	lang: string;
	code: string;
	/** The closing fence arrived; an open one is still streaming. */
	closed: boolean;
};

export type FenceKind = 'mermaid' | 'svg' | 'html';

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;

/** Every fenced code block of `text`, in order. */
export function scanFences(text: string): Fence[] {
	const out: Fence[] = [];
	const lines = text.split('\n');
	let i = 0;
	while (i < lines.length) {
		const m = OPEN.exec(lines[i] ?? '');
		if (!m) {
			i++;
			continue;
		}
		const marker = m[1] as string;
		const lang = (m[2] ?? '').toLowerCase();
		const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
		const body: string[] = [];
		let closed = false;
		i++;
		while (i < lines.length) {
			if (close.test(lines[i] ?? '')) {
				closed = true;
				i++;
				break;
			}
			body.push(lines[i] as string);
			i++;
		}
		out.push({ index: out.length, lang, code: body.join('\n'), closed });
	}
	return out;
}

const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const HTML_DOC = /<!doctype\s+html|<html[\s>]|<body[\s>]|<script[\s>]/i;

/** What a fence previews as, or `undefined` for an ordinary code block. */
export function fenceKind(f: Pick<Fence, 'lang' | 'code'>): FenceKind | undefined {
	if (f.lang === 'mermaid') return 'mermaid';
	if (f.lang === 'svg') return 'svg';
	if ((f.lang === '' || f.lang === 'xml') && SVG_START.test(f.code)) return 'svg';
	if ((f.lang === 'html' || f.lang === 'htm') && HTML_DOC.test(f.code)) return 'html';
	return undefined;
}

/** The text of a message as the fence scan sees it. */
export function messageText(message: { parts: readonly { type: string; text?: unknown }[] }): string {
	return message.parts
		.filter((p) => p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text as string)
		.join('\n\n');
}

/** The previewable fence at `index` of a message, when it exists and is complete. */
export function previewFence(message: { parts: readonly { type: string; text?: unknown }[] }, index: number): (Fence & { kind: FenceKind }) | undefined {
	const f = scanFences(messageText(message))[index];
	if (!f || !f.closed) return undefined;
	const kind = fenceKind(f);
	return kind ? { ...f, kind } : undefined;
}

/** The index a rendered block has inside its message: the first fence with the same language and code. */
export function fenceIndexOf(fences: readonly Fence[], lang: string, code: string): number {
	const norm = (s: string): string => s.replace(/\n+$/, '');
	const at = fences.findIndex((f) => f.lang === lang.toLowerCase() && norm(f.code) === norm(code));
	return at;
}

/** Entry file name and artifact kind of a fence kept as an artifact ("Save as artifact"). */
export function fenceArtifact(kind: FenceKind): { kind: 'mermaid' | 'image' | 'html'; file: string; mime: string } {
	if (kind === 'mermaid') return { kind: 'mermaid', file: 'diagram.mmd', mime: 'text/plain' };
	if (kind === 'svg') return { kind: 'image', file: 'image.svg', mime: 'image/svg+xml' };
	return { kind: 'html', file: 'index.html', mime: 'text/html' };
}
