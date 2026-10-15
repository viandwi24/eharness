// Images a tool stored as files and returned as media references: the filesystem's own
// `{ type: 'media-ref', path, mediaType }` (read_file, browser screenshots) and the references
// the core puts in an MCP result when it offloads the base64 (`{ content: [{ type: 'image',
// ref: { type: 'media-ref', path, mediaType } }] }`, spec 09 §4).

export interface ToolImage {
	path: string;
	mediaType: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function asImage(ref: unknown): ToolImage | undefined {
	if (!isRecord(ref) || ref.type !== 'media-ref' || typeof ref.path !== 'string') return undefined;
	const mediaType = typeof ref.mediaType === 'string' ? ref.mediaType : '';
	return mediaType.startsWith('image/') ? { path: ref.path, mediaType } : undefined;
}

/** The images a tool output refers to, in order (none for any other output). */
export function toolImages(output: unknown): ToolImage[] {
	const direct = asImage(output);
	if (direct) return [direct];
	if (!isRecord(output) || !Array.isArray(output.content)) return [];
	const out: ToolImage[] = [];
	for (const part of output.content) {
		if (isRecord(part) && part.type === 'image') {
			const image = asImage(part.ref);
			if (image) out.push(image);
		}
	}
	return out;
}

/** The MCP result parts of an output that carries image references: text and images, in order. */
export type ToolContent = { kind: 'text'; text: string } | { kind: 'image'; image: ToolImage };

/** Text and image parts of an MCP result with image references, or `undefined` for another output. */
export function toolContent(output: unknown): ToolContent[] | undefined {
	if (!isRecord(output) || !Array.isArray(output.content)) return undefined;
	if (toolImages(output).length === 0) return undefined;
	const out: ToolContent[] = [];
	for (const part of output.content) {
		if (!isRecord(part)) continue;
		if (part.type === 'text' && typeof part.text === 'string') out.push({ kind: 'text', text: part.text });
		else if (part.type === 'image') {
			const image = asImage(part.ref);
			if (image) out.push({ kind: 'image', image });
		}
	}
	return out;
}
