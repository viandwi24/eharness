import { dayNumber, formatClock, formatDate } from './time';

/** Short sidebar time: HH:MM today, "Yesterday", weekday within a week, else a date. */
export function formatTime(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) return '';
	// calendar days of the team timezone, like every time in the app
	const diff = dayNumber(now) - dayNumber(ms);
	if (diff <= 0) return formatClock(ms);
	if (diff === 1) return 'Yesterday';
	if (diff < 7) return formatDate(ms, { weekday: 'short' });
	return formatDate(ms);
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
