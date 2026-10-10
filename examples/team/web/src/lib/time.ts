/** Compact relative time: "now", "5m", "3h", "2d", else a short date. */
export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) return '';
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 45) return 'now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	if (d < 7) return `${d}d`;
	return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** USD with enough precision for small agent costs. */
export const formatUsd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
