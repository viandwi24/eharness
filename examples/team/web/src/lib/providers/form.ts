// Pure logic of the schema-driven form: the field list of `GET /providers` (`ProviderField`) in,
// form values and a settings patch out. No Svelte, no DOM: tested in form.test.ts.
import type { components } from '../api/schema';

export type FormField = components['schemas']['ProviderField'];

/** One row of a key-value field. `stored`: the value is saved on the server; empty keeps it. */
export type RecordRow = { key: string; value: string; stored: boolean };

/** Text for inputs and selects, a boolean for switches, rows for key-value fields. */
export type FormValue = string | boolean | RecordRow[];
export type FormValues = Record<string, FormValue>;

export type SecretStatus = { set: boolean; hint?: string };

/** `{ set, hint? }` of a redacted secret, or undefined for anything else. */
export function secretStatus(v: unknown): SecretStatus | undefined {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
	const o = v as { set?: unknown; hint?: unknown };
	if (typeof o.set !== 'boolean') return undefined;
	return { set: o.set, ...(typeof o.hint === 'string' ? { hint: o.hint } : {}) };
}

export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split('.')) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

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

/** Groups in display order; `advanced` is collapsed by default. */
export const GROUP_ORDER = ['auth', 'endpoint', 'advanced'] as const;
export const GROUP_LABEL: Record<(typeof GROUP_ORDER)[number], string> = {
	auth: 'Authentication',
	endpoint: 'Endpoint',
	advanced: 'Advanced'
};

export function groupFields(fields: readonly FormField[]): { group: (typeof GROUP_ORDER)[number]; fields: FormField[] }[] {
	return GROUP_ORDER.map((group) => ({ group, fields: fields.filter((f) => f.group === group) })).filter((g) => g.fields.length > 0);
}

/** The input a field renders with (the definition's widget, else the default of its kind). */
export type Control = 'password' | 'text' | 'textarea' | 'number' | 'switch' | 'select' | 'radio' | 'keyvalue' | 'json';
export function controlOf(f: FormField): Control {
	if (f.kind === 'record' || f.widget === 'keyvalue') return 'keyvalue';
	if (f.kind === 'boolean') return 'switch';
	if (f.kind === 'enum') return f.widget === 'radio' ? 'radio' : 'select';
	if (f.kind === 'array' || f.kind === 'json') return 'json';
	if (f.secret || f.widget === 'password') return 'password';
	if (f.widget === 'textarea') return 'textarea';
	if (f.kind === 'number' || f.kind === 'integer') return 'number';
	return 'text';
}

/** Show a field only while another field has the value `showWhen` asks for. */
export function isVisible(f: FormField, values: FormValues): boolean {
	const w = f.showWhen;
	if (!w) return true;
	const v = values[w.field];
	const shown = typeof v === 'string' || typeof v === 'boolean' ? String(v) : '';
	if (w.in !== undefined) return w.in.some((x) => String(x) === shown);
	if (w.equals !== undefined) return String(w.equals) === shown;
	return shown !== '' && shown !== 'false';
}

const textOf = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Form values for `fields`, from the redacted `current` settings of a profile (or defaults). */
export function initialValues(fields: readonly FormField[], current?: Record<string, unknown>): FormValues {
	const out: FormValues = {};
	for (const f of fields) {
		const cur = current === undefined ? undefined : getPath(current, f.path);
		const c = controlOf(f);
		if (c === 'keyvalue') {
			const rows: RecordRow[] = [];
			if (cur !== null && typeof cur === 'object') {
				for (const [key, value] of Object.entries(cur as Record<string, unknown>)) {
					rows.push(f.secretValues ? { key, value: '', stored: secretStatus(value)?.set === true } : { key, value: textOf(value), stored: false });
				}
			}
			out[f.path] = rows;
		} else if (c === 'switch') {
			out[f.path] = typeof cur === 'boolean' ? cur : typeof f.default === 'boolean' ? f.default : false;
		} else if (c === 'password') {
			out[f.path] = ''; // a stored secret is never sent back: empty = keep
		} else if (c === 'json') {
			out[f.path] = cur === undefined ? (f.default === undefined ? '' : JSON.stringify(f.default)) : JSON.stringify(cur);
		} else {
			out[f.path] = cur === undefined ? textOf(f.default) : textOf(cur);
		}
	}
	return out;
}

export type BuildResult = { ok: true; settings: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/**
 * The settings patch for POST (`create`) or PATCH (`edit`). Edit semantics follow the server's
 * keep-secret rules: an untouched secret is left out, a cleared optional field becomes `null`,
 * an unchanged stored header value is sent as `''`.
 */
export function buildSettings(
	fields: readonly FormField[],
	values: FormValues,
	current: Record<string, unknown> | undefined,
	mode: 'create' | 'edit'
): BuildResult {
	const settings: Record<string, unknown> = {};
	const errors: Record<string, string> = {};
	const had = (path: string): boolean => {
		const cur = current === undefined ? undefined : getPath(current, path);
		return cur !== undefined && cur !== null && secretStatus(cur)?.set !== false;
	};
	for (const f of fields) {
		if (!isVisible(f, values)) continue;
		const v = values[f.path];
		const c = controlOf(f);
		const clear = (): void => {
			if (mode === 'edit' && had(f.path) && !f.secret) setPath(settings, f.path, null);
			else if (f.required && !(mode === 'edit' && had(f.path))) errors[f.path] = `${f.label} is required`;
		};
		if (c === 'switch') {
			setPath(settings, f.path, v === true);
		} else if (c === 'keyvalue') {
			const rows = ((v as RecordRow[] | undefined) ?? []).filter((r) => r.key.trim() !== '' || r.value !== '');
			if (rows.length === 0) {
				clear();
				continue;
			}
			const rec: Record<string, string> = {};
			for (const r of rows) {
				const key = r.key.trim();
				if (key === '') errors[f.path] = `${f.label}: every row needs a name`;
				else if (key in rec) errors[f.path] = `${f.label}: "${key}" appears twice`;
				else if (r.value === '' && !(r.stored && mode === 'edit')) errors[f.path] = `${f.label}: "${key}" needs a value`;
				else rec[key] = r.value;
			}
			setPath(settings, f.path, rec);
		} else {
			const text = typeof v === 'string' ? v : '';
			if (c === 'password') {
				if (text === '') {
					if (!(mode === 'edit' && had(f.path)) && f.required) errors[f.path] = `${f.label} is required`;
				} else setPath(settings, f.path, text);
				continue;
			}
			if (text.trim() === '') {
				clear();
			} else if (c === 'number') {
				const n = Number(text);
				if (!Number.isFinite(n)) errors[f.path] = `${f.label} must be a number`;
				else if (f.kind === 'integer' && !Number.isInteger(n)) errors[f.path] = `${f.label} must be a whole number`;
				else if (f.min !== undefined && n < f.min) errors[f.path] = `${f.label} must be at least ${f.min}`;
				else if (f.max !== undefined && n > f.max) errors[f.path] = `${f.label} must be at most ${f.max}`;
				else setPath(settings, f.path, n);
			} else if (c === 'json') {
				try {
					setPath(settings, f.path, JSON.parse(text));
				} catch {
					errors[f.path] = `${f.label} is not valid JSON`;
				}
			} else if (f.kind === 'enum') {
				const option = f.options?.find((o) => String(o.value) === text);
				setPath(settings, f.path, option === undefined ? text : option.value);
			} else {
				setPath(settings, f.path, text.trim());
			}
		}
	}
	return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings };
}

/** Which of the profile's secrets are stored (for the "keep current" placeholder). */
export function secretOfField(current: Record<string, unknown> | undefined, path: string): SecretStatus | undefined {
	return current === undefined ? undefined : secretStatus(getPath(current, path));
}

/** `apiKey` -> `OPENROUTER_API_KEY` hints of an env profile: the variables that supplied it. */
export function envVariables(envMap: Record<string, string>, settings: Record<string, unknown>): string[] {
	return Object.entries(envMap)
		.filter(([field]) => getPath(settings, field) !== undefined)
		.map(([, variable]) => variable);
}
