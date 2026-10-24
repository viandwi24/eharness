import { apiBase, authFetch, getToken } from '#lib/api/index.js';

/** Save the audit as CSV: the same filters as the list, fetched with the token, saved as a file. */
export async function downloadAuditCsv(query: Record<string, string | number>): Promise<void> {
	const token = getToken();
	const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
	const res = await authFetch(`${apiBase.replace(/\/+$/, '')}/audit/actions.csv${qs.size > 0 ? `?${qs}` : ''}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {}
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		throw new Error(body.error?.message ?? `Export failed (${res.status})`);
	}
	const url = URL.createObjectURL(await res.blob());
	const a = document.createElement('a');
	a.href = url;
	a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
