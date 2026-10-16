// Very large text (a tool output, a long reply) is shown as a plain preview first; the full text
// is rendered on request. Pure, unit-tested.
export const BIG_OUTPUT = 20_000;
export const BIG_TEXT = 30_000;
export const PREVIEW_CHARS = 2_000;

export type Preview = { big: boolean; shown: string; hidden: number };

/** The first `preview` characters (cut at a line end when one is near) of a text longer than `over`, else all of it. */
export function previewText(text: string, over = BIG_OUTPUT, preview = PREVIEW_CHARS): Preview {
	if (text.length <= over) return { big: false, shown: text, hidden: 0 };
	let cut = text.slice(0, preview);
	const nl = cut.lastIndexOf('\n');
	if (nl > preview * 0.6) cut = cut.slice(0, nl);
	return { big: true, shown: cut, hidden: text.length - cut.length };
}

/** "1.8 MB", "250 KB". */
export function sizeLabel(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(chars / 1000))} KB`;
}
