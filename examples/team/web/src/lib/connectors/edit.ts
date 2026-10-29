// Editing a saved custom connector: the connector's own fields (`GET /connectors`) filled from the
// connection's redacted settings, and the PATCH settings back. Stored secrets left blank are kept
// (the server's keep-secret rules). No Svelte, no DOM: tested in edit.test.ts.
import { buildSettings, initialValues, type BuildResult, type FormField, type FormValues, type RecordRow } from '../providers/form';

/** The form values of a connection: plain fields filled, secrets empty ("leave empty to keep"). */
export function editValues(fields: readonly FormField[], settings: Record<string, unknown>): FormValues {
	return initialValues(fields, settings);
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The `settings` of `PATCH /connections/{id}`. Besides the field rules of `buildSettings`: the URL
 * may not be emptied, and a new URL needs the header values typed again, because the server never
 * sends stored values to another endpoint (it would drop them silently).
 */
export function editPatch(fields: readonly FormField[], values: FormValues, current: Record<string, unknown>): BuildResult {
	const built = buildSettings(fields, values, current, 'edit');
	const errors: Record<string, string> = built.ok ? {} : { ...built.errors };
	if (fields.some((f) => f.path === 'url') && text(values.url) === '') errors.url = 'Enter the server URL';
	const moved = text(values.url) !== '' && text(values.url) !== text(current.url);
	if (moved && values.authMode === 'headers') {
		const blank = ((values.headers as RecordRow[] | undefined) ?? []).filter((r) => r.stored && r.value === '' && r.key.trim() !== '');
		if (blank.length > 0) {
			const names = blank.map((r) => r.key.trim()).join(', ');
			errors.headers = `Type ${names} again: a new URL never receives the stored values.`;
		}
	}
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return built;
}
