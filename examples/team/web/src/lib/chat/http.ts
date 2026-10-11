// Upload error text for a toast (size, type, other). The chat itself is `eharness/client`.

export function uploadErrorText(status: number, body: unknown, name: string): string {
	const e = (body as { error?: { message?: unknown } } | null)?.error;
	const detail = typeof e?.message === 'string' ? `: ${e.message}` : '';
	if (status === 413) return `${name} is too large (max 10 MB)`;
	if (status === 400 || status === 415 || status === 422) return `${name} was rejected${detail}`;
	return `Could not upload ${name}${detail}`;
}
