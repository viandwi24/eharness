/** Short sidebar time: HH:MM today, "Yesterday", weekday within a week, else a date. */
export function formatTime(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) return '';
	const d = new Date(ms);
	const n = new Date(now);
	const day = (x: Date): number => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
	const diff = day(n) - day(d);
	if (diff <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (diff === 1) return 'Yesterday';
	if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * One plain line from markdown, for previews (sidebar, thread list): no emphasis marks, headings,
 * list bullets, link or image syntax, code fences or HTML tags; whitespace collapsed.
 */
export function stripMarkdown(text: string | null | undefined): string {
	if (!text) return '';
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>\n]+>/g, ' ')
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
		.replace(/(\*\*|__)(.+?)\1/g, '$2')
		.replace(/(\*|_)([^*_\n]+?)\1/g, '$2')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}
