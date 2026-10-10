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
