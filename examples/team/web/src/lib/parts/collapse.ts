// Long messages of the person (a pasted log, a whole document) collapse behind "Show more" so
// one bubble does not fill the chat. Pure, unit-tested.
export const COLLAPSE_OVER = 2000;
export const COLLAPSED_PREVIEW = 600;

export type CollapsedText = { collapsed: boolean; shown: string; hidden: number };

/** The preview of `text` when it is longer than `over` characters (cut at a line or word end), else all of it. */
export function collapseText(text: string, over = COLLAPSE_OVER, preview = COLLAPSED_PREVIEW): CollapsedText {
	if (text.length <= over) return { collapsed: false, shown: text, hidden: 0 };
	let cut = text.slice(0, preview);
	const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
	if (lastBreak > preview * 0.6) cut = cut.slice(0, lastBreak);
	return { collapsed: true, shown: cut.trimEnd(), hidden: text.length - cut.length };
}
