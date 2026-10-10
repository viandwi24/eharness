// Pure helpers of the connect flow views (no Svelte, no DOM): payloads, titles, countdown text.
import type { ConnectFlow, Connection, FlowView } from '../api/client';
import { buildSettings, controlOf, getPath, isVisible, secretStatus, type FormField, type FormValues } from '../providers/form';

type View<T extends FlowView['type']> = Extract<FlowView, { type: T }>;

export type SubmitResult = { ok: true; data: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.');
	let cur = obj;
	for (const part of parts.slice(0, -1)) {
		const next = cur[part];
		if (next === null || typeof next !== 'object') cur[part] = {};
		cur = cur[part] as Record<string, unknown>;
	}
	cur[parts[parts.length - 1] as string] = value;
}

/** The `data` of a form submit: values by field path; a stored secret left empty is `{ keep: true }`. */
export function formPayload(fields: readonly FormField[], values: FormValues, current: Record<string, unknown>): SubmitResult {
	const built = buildSettings(fields, values, current, 'edit');
	if (!built.ok) return built;
	const data = built.settings;
	for (const f of fields) {
		if (!isVisible(f, values) || controlOf(f) !== 'password') continue;
		if (secretStatus(getPath(current, f.path))?.set === true && getPath(data, f.path) === undefined) setPath(data, f.path, { keep: true });
	}
	return { ok: true, data };
}

/** The `data` of a choose submit (always a list; the server accepts a single value too). */
export function choosePayload(selected: readonly string[]): { selected: string[] } {
	return { selected: [...selected] };
}

/** Local validation of a choose view: a message, or undefined when the choice is fine. */
export function chooseError(view: View<'choose'>, selected: readonly string[]): string | undefined {
	if (!view.multiple) return selected.length === 1 ? undefined : 'Choose one option.';
	return selected.length >= view.min ? undefined : view.min <= 1 ? 'Choose at least one.' : `Choose at least ${view.min}.`;
}

/** Toggle one option (single choice replaces, multiple adds or removes). */
export function toggleSelected(selected: readonly string[], value: string, multiple: boolean): string[] {
	if (!multiple) return [value];
	return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

/** Whether the flow ended with a saved connection. */
export function flowSucceeded(flow: ConnectFlow | null, connection: Connection | null): boolean {
	return flow?.status === 'done' && connection !== null;
}

/** Whether the flow ended without a connection (failed or cancelled). */
export function flowEndedBadly(flow: ConnectFlow | null): boolean {
	return flow?.status === 'failed' || flow?.status === 'cancelled';
}

/** The heading of a view. */
export function viewTitle(view: FlowView): string {
	switch (view.type) {
		case 'form':
		case 'oauth':
		case 'deviceCode':
		case 'choose':
		case 'confirm':
			return view.title;
		case 'status':
			return view.state === 'success' ? 'Connected' : 'Connecting';
		case 'error':
			return 'Something went wrong';
	}
}

/** Whether the view kind has a Back action (and it is not the first step of the flow). */
export const canGoBack = (view: FlowView, firstStep: string | undefined): boolean =>
	(view.type === 'form' || view.type === 'choose' || view.type === 'confirm' || view.type === 'error') && view.step !== firstStep;

/** "Expires in 4 min" / "Expired", from a millisecond deadline. */
export function countdownText(expiresAt: number, now: number): string {
	const ms = expiresAt - now;
	if (ms <= 0) return 'Expired';
	const s = Math.ceil(ms / 1000);
	if (s < 60) return `Expires in ${s} sec`;
	const m = Math.ceil(s / 60);
	return `Expires in ${m} min`;
}

/** The link to open for a device code (the one that already carries the code when there is one). */
export const deviceLink = (view: View<'deviceCode'>): string => view.verificationUrlComplete ?? view.verificationUrl;

/** Only http(s) links are opened. */
export const safeUrl = (url: string): boolean => /^https?:\/\//i.test(url);
