// Pure helpers of the browser pages: state badges, live-frame parsing, pointer mapping, key mapping,
// byte formatting. No Svelte, no DOM: tested in model.test.ts.
import type { components } from '../api/schema';

export type BrowserProfile = components['schemas']['BrowserProfile'];
export type BrowserAdapter = components['schemas']['BrowserAdapter'];
export type BrowserRuntime = components['schemas']['BrowserRuntime'];
export type BrowserUsage = components['schemas']['BrowserUsage'];
export type BrowserOverview = components['schemas']['BrowserOverview'];
export type BrowserShot = components['schemas']['BrowserShot'];
export type BrowserMode = BrowserProfile['mode'];

export type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive' | 'outline';

/** The badge of a profile: who holds the browser, or why it is not usable yet. */
export function stateBadge(p: Pick<BrowserProfile, 'state' | 'lease'>): { label: string; variant: BadgeVariant } {
	switch (p.state) {
		case 'missing':
			return { label: 'Missing', variant: 'secondary' };
		case 'installing':
			return { label: 'Installing', variant: 'info' };
		case 'ready':
			return { label: 'Ready', variant: 'success' };
		case 'running':
			return { label: 'Running', variant: 'success' };
		case 'in-use':
			return { label: `In use by ${p.lease?.heldBy?.name ?? 'an agent'}`, variant: 'info' };
		case 'controlled':
			return { label: `Controlled by ${p.lease?.controller.holder ? viewerLabel(p.lease.controller.holder) : 'a person'}`, variant: 'warning' };
		default:
			return { label: 'Error', variant: 'destructive' };
	}
}

/** "client:ab12cd34" is a viewer id; people see a short name. */
export function viewerLabel(id: string): string {
	return id.startsWith('client:') ? `viewer ${id.slice(7, 11)}` : id;
}

export const modeLabel = (m: BrowserMode): string => (m === 'manual' ? 'Existing browser' : 'Runs on this server');

export type RuntimeView = { label: string; variant: BadgeVariant; percent: number | null };

/** Runtime state for the card; `percent` is null while the total is unknown. */
export function runtimeView(r: Pick<BrowserRuntime, 'state' | 'progress'>): RuntimeView {
	const percent = r.progress?.total ? Math.min(100, Math.round((r.progress.received / r.progress.total) * 100)) : null;
	switch (r.state) {
		case 'missing':
			return { label: 'Missing', variant: 'secondary', percent: null };
		case 'installing':
			return { label: 'Installing', variant: 'info', percent };
		case 'ready':
			return { label: 'Ready', variant: 'success', percent: null };
		case 'starting':
			return { label: 'Starting', variant: 'info', percent: null };
		case 'running':
			return { label: 'Running', variant: 'success', percent: null };
		case 'stopping':
			return { label: 'Stopping', variant: 'secondary', percent: null };
		default:
			return { label: 'Error', variant: 'destructive', percent: null };
	}
}

export function formatBytes(n: number | undefined | null): string {
	if (n === undefined || n === null || !Number.isFinite(n)) return '—';
	if (n < 1024) return `${Math.round(n)} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const formatMb = (n: number | undefined): string => (n === undefined ? '—' : `${Math.round(n / (1024 * 1024))} MB`);
export const formatCpu = (n: number | undefined): string => (n === undefined ? '—' : `${n.toFixed(n < 10 ? 1 : 0)} %`);

// --- live frames -------------------------------------------------------------------------------

export type FrameHeader = { type: 'frame'; seq: number; width: number; height: number; mediaType: string; at: number };

/**
 * A binary live message: 4-byte big-endian header length, JSON header, image bytes.
 * Returns undefined for anything malformed (the viewer drops it).
 */
export function parseFrame(buf: ArrayBuffer): { header: FrameHeader; image: Uint8Array } | undefined {
	if (buf.byteLength < 4) return undefined;
	const len = new DataView(buf).getUint32(0);
	if (len === 0 || 4 + len > buf.byteLength) return undefined;
	try {
		const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as Partial<FrameHeader>;
		if (h.type !== 'frame' || typeof h.width !== 'number' || typeof h.height !== 'number' || h.width <= 0 || h.height <= 0) return undefined;
		return {
			header: { type: 'frame', seq: h.seq ?? 0, width: h.width, height: h.height, mediaType: h.mediaType ?? 'image/jpeg', at: h.at ?? 0 },
			image: new Uint8Array(buf, 4 + len)
		};
	} catch {
		return undefined;
	}
}

/** Where a frame of `frame` pixels sits inside a `box` (letterbox: centred, aspect kept). */
export function letterbox(box: { width: number; height: number }, frame: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
	if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
	const scale = Math.min(box.width / frame.width, box.height / frame.height);
	const width = frame.width * scale;
	const height = frame.height * scale;
	return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** A pointer position in the canvas box (CSS px) to frame pixels; undefined outside the frame. */
export function mapPointer(point: { x: number; y: number }, box: { width: number; height: number }, frame: { width: number; height: number }): { x: number; y: number } | undefined {
	const r = letterbox(box, frame);
	if (r.width === 0) return undefined;
	const fx = ((point.x - r.x) / r.width) * frame.width;
	const fy = ((point.y - r.y) / r.height) * frame.height;
	if (fx < 0 || fy < 0 || fx > frame.width || fy > frame.height) return undefined;
	return { x: Math.round(fx), y: Math.round(fy) };
}

// --- input -------------------------------------------------------------------------------------

export type LiveInput =
	| { type: 'mouse'; event: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
	| { type: 'key'; event: 'down' | 'up' | 'char'; key: string; code?: string; text?: string; modifiers?: number }
	| { type: 'text'; text: string }
	| { type: 'navigate'; url: string };

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
	return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export const buttonOf = (b: number): 'left' | 'middle' | 'right' => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left');

/**
 * A keyboard event as live input: a printable key (no Ctrl/Meta) is one `char` event, every other key a
 * `down` (the caller sends `up` on keyup).
 */
export function keyInput(e: { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, phase: 'down' | 'up'): LiveInput[] {
	const modifiers = modifiersOf(e);
	const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
	if (printable) return phase === 'down' ? [{ type: 'key', event: 'char', key: e.key, code: e.code, text: e.key, modifiers }] : [];
	return [{ type: 'key', event: phase, key: e.key, code: e.code, modifiers }];
}

/** A URL typed in the bar: adds https:// when no scheme is given. */
export function normalizeUrl(text: string): string {
	const t = text.trim();
	if (t === '') return '';
	return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
}

/** The live WebSocket address for an API base (absolute or a path) and a page origin. */
export function liveUrl(apiBase: string, profileId: string, origin: string): string {
	const base = /^https?:\/\//i.test(apiBase) ? apiBase : `${origin}${apiBase.startsWith('/') ? '' : '/'}${apiBase}`;
	return `${base.replace(/\/+$/, '').replace(/^http/i, 'ws')}/browser/profiles/${encodeURIComponent(profileId)}/live`;
}

export type Controller = { by: 'agent' | 'human'; holder?: string; since: number; reason?: string };

/** One line of the banner above the live view. */
export function controllerText(c: Controller | undefined, youId: string | undefined): string {
	if (!c) return 'Connecting…';
	if (c.by === 'human') return c.holder && c.holder === youId ? 'You are in control. The agent waits.' : `${c.holder ? viewerLabel(c.holder) : 'A person'} is in control.`;
	return c.reason ? `The agent asked for you: ${c.reason}` : 'The agent controls this browser. You are watching.';
}

/** Domain lines of the settings box to a list (one per line or comma separated). */
export function parseDomains(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}
