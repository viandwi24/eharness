// Windowed mounting of a long chat: only the newest messages are mounted, older loaded ones are
// revealed in steps before the server is asked for more. Pure, unit-tested.
export const WINDOW_SIZE = 20;
export const PAGE_SIZE = 20;
/** A tool output or message part this long is "clipped" by the server and loaded in full on demand. */
export const CLIP_CHARS = 2000;

/** Index of the first mounted message: the one `startId` names, else the newest `size`. Never negative. */
export function windowStart(ids: readonly string[], startId: string | null, size = WINDOW_SIZE): number {
	if (startId !== null) {
		const at = ids.indexOf(startId);
		if (at >= 0) return at;
	}
	return Math.max(0, ids.length - size);
}

/** The id the window starts at after revealing `step` more (older) messages; the first id when all are shown. */
export function revealEarlier(ids: readonly string[], start: number, step = WINDOW_SIZE): string | null {
	if (ids.length === 0) return null;
	return ids[Math.max(0, start - step)] ?? null;
}
